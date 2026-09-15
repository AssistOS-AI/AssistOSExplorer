/*
 The config object contains  definitions of objects that have a availableBalance and a lockedBalance, plus any other properties that are needed.
 For the creation of these objects and the management of their properties, dynamic functions are created based on configuration.

 */
const {transformToAccountID, MathMoney} = require("./utils.cjs");
const AUDIT_EVENTS = require("../audit/AuditEvents.cjs");
const SYSLOG_EVENTS = require("../audit/SyslogEvents.cjs");

function AssetsMixin(smartStorage, systemAudit) {
    console.debug(">>>>> Start initialisation of AssetsMixin");
    let self = this;

    let configMap = {};

    this.configureAssets = async function (config) {
        for (let itemType in config) {
            configMap[itemType] = {};
            config[itemType].forEach(property => {
                configMap[itemType][property] = true;
            });
        }
        for (let assetType in config) {
            addFunctionToSelf("create", assetType, "", getCreationFunction(assetType));
            addFunctionToSelf("delete", assetType, "", async function (objectID) {
                await smartStorage.deleteObject(assetType, objectID);
                await systemAudit.smartLog(SYSLOG_EVENTS.DELETE, {assetType, objectID})
            });

            addFunctionToSelf("get", assetType, "", async function (objectID) {
                return await smartStorage.loadObject(objectID);
            });

            addFunctionToSelf("update", assetType, "", async function (objectID, values) {
                let obj = await smartStorage.loadObject(objectID);
                for (let key in values) {
                    if (!hasField(assetType, key)) {
                        throw new Error("Invalid property named " + key + " for item type " + assetType);
                    }
                }
                await smartStorage.updateObject(objectID, values);
                return obj;
            });

            config[assetType].forEach(property => {
                addFunctionToSelf("get", assetType, property, getGetterFunction(assetType, property));
                addFunctionToSelf("set", assetType, property, getSetterFunction(assetType, property));
            });
        }
    }

    function hasField(itemType, field) {
        return configMap[itemType][field] === true;
    }

    const upCaseFirstLetter = name => name.replace(/^./, name[0].toUpperCase());

    function addFunctionToSelf(methodCategory, selfTypeName, name, func) {
        let funcName = methodCategory + upCaseFirstLetter(selfTypeName) + (name !== "" ? upCaseFirstLetter(name) : "");
        console.debug("Adding function " + funcName + " to object of type: " + selfTypeName);
        if (self[funcName] !== undefined) {
            throw new Error("Function " + funcName + " already exists! Refusing to overwrite, change your configurations!");
        }
        self[funcName] = func.bind(self);
    }

    async function nextObjectID(itemType) {
        let firstLetter = itemType[0].toUpperCase();
        let currentNumber = await smartStorage.getNextNumber(itemType);
        let niceId = transformToAccountID(currentNumber, firstLetter);
        //console.debug(">>>> Next object ID for type " + itemType + " is " + niceId + " with account number " + currentIdNumber);
        return {accountNumber: currentNumber, id: niceId};
    }

    function getCreationFunction(itemType) {
        return async function (initialValues) {
            let {accountNumber, id} = await nextObjectID(itemType);
            let obj = {accountNumber};
            for (let property in initialValues) {
                if (!hasField(itemType, property)) {
                    await $$.throwError(new Error("Invalid property named " + property + " in initialisation values for item type " + itemType));
                    return undefined;
                }
                obj.availableBalance = 0;
                obj.lockedBalance = 0;
                obj[property] = initialValues[property];
            }
            //console.debug(">>>> Created object of type " + itemType + " with id " + id, JSON.stringify(obj));
            obj = await smartStorage.createObject(id, obj);
            await systemAudit.smartLog(SYSLOG_EVENTS.CREATE_OBJECT, {itemType, id})
            return obj;
        }
    }

    function getGetterFunction(itemType, property) {
        return async function (objectID) {
            let obj = await smartStorage.loadObject(objectID);
            return obj[property];
        }
    }

    function getSetterFunction(itemType, property) {
        //console.log(config[itemType]);
        return async function (objectID, value) {
            if (!hasField(itemType, property)) {
                await $$.throwError(new Error("Unknown property named " + property + " for item type " + itemType));
            }
            await smartStorage.updateProperty(objectID, property, value);
            return value;
        }
    }

    this.getBalance = async function (objectID) {
        let obj = await smartStorage.loadObject(objectID);
        if (!obj.availableBalance) {
            obj.availableBalance = 0;
        }
        return MathMoney.normalise(obj.availableBalance);
    }

    this.getLockedBalance = async function (objectID) {
        let obj = await smartStorage.loadObject(objectID);
        if (!obj.lockedBalance) {
            obj.lockedBalance = 0;
        }
        return MathMoney.normalise(obj.lockedBalance);
    }

    this.mintPoints = async function (amount) {
        amount = MathMoney.normalise(amount);
        let initialMintingDone = await smartStorage.getProperty("system", "initialMintingDone");
        if (initialMintingDone === true) {
            await $$.throwError(new Error("Initial minting already done!"), "Failing to mint " + amount + " points", "Initial minting already done!");
        }

        let availableBalance = await this.getBalance("system");
        if (availableBalance === undefined || isNaN(availableBalance)) {
            availableBalance = 0;
        }
        availableBalance += amount;
        await smartStorage.updateProperty("system", "availableBalance", availableBalance);
        await smartStorage.updateProperty("system", "initialMintingDone", true);
        await systemAudit.smartLog(AUDIT_EVENTS.MINT, {amount, reason: "Initial minting"})
        return true;
    }

    this.rewardFounder = async function (userID, amount) {
        amount = MathMoney.normalise(amount);
        let foundersRewardDone = await smartStorage.getProperty("system", "foundersRewardDone");
        if (foundersRewardDone === true) {
            await $$.throwError(new Error("Founders already rewarded!"), "Failing to reward " + amount + " points", "Founders already rewarded!");
        }
        await this.rewardUser(userID, amount, "Founders reward");
        await smartStorage.updateProperty("system", "foundersRewardDone", true);
        return true;
    }

    this.lockPoints = async function (objectID, amount, reason) {
        amount = MathMoney.normalise(amount);
        //console.debug(" >>>>> Locking " + amount + " points for " + objectID + " for " + reason);
        let obj = await smartStorage.loadObject(objectID);
        //await console.debug(" <<<<<< Dumping object before locking", obj);
        if (obj.availableBalance < amount) {
            await $$.throwError(new Error("Insufficient points to lock"), "Failing to lock " + amount + " points", " having only " + obj.availableBalance);
        }
        obj.availableBalance -= amount;
        obj.lockedBalance += amount;
        //await console.debug(" <<<<<< Dumping object after locking", obj);
        await smartStorage.updateObject(objectID, {
            "lockedBalance": obj.lockedBalance,
            "availableBalance": obj.availableBalance
        });
        await systemAudit.smartLog(AUDIT_EVENTS.LOCK, {userID: objectID, amount, reason})

        return true;
    }

    this.unlockPoints = async function (objectID, amount, reason) {
        amount = MathMoney.normalise(amount);
        //console.debug(" >>>>> Unlocking " + amount + " points for " + objectID + " for " + reason);
        let obj = await smartStorage.loadObject(objectID);
        if (obj.lockedBalance < amount) {
            await $$.throwError(new Error("Insufficient points to unlock " + amount + " points" + " having only " + obj.lockedBalance));
        }
        obj.lockedBalance -= amount;
        obj.availableBalance += amount;
        await smartStorage.updateObject(objectID, {
            "lockedBalance": obj.lockedBalance,
            "availableBalance": obj.availableBalance
        });
        await systemAudit.smartLog(AUDIT_EVENTS.UNLOCK, {userID: objectID, amount, reason})

        return true;
    }

    this.rewardUser = async function (userID, amount, reason) {
        amount = MathMoney.normalise(amount);
        //console.debug(">>>> Start rewarding user " + userID + " with " + amount + " points for " + reason);
        await self.transferPoints(amount, "system", userID, reason);
     //   await systemAudit.smartLog(AUDIT_EVENTS.REWARD, {userID, amount, reason})
        //console.debug(">>>> Rewarded user " + userID + " with " + amount + " points for " + reason);
        return true;
    }

    this.confiscateLockedPoints = async function (userID, amount, reason) {
        amount = MathMoney.normalise(amount);
        //console.debug(">>>> Confiscating " + amount + " points from " + userID + " for " + reason);
        await smartStorage.loadObject(userID);
        await self.transferLockedPoints(amount, userID, "system", reason);
        await self.unlockPoints("system", amount, reason);
        await systemAudit.smartLog(AUDIT_EVENTS.CONFISCATE_LOCKED, {userID, amount, reason})
        return true;
    }

    this.transferPoints = async function (amount, fromID, toID, reason) {
        amount = MathMoney.normalise(amount);
        let fromObj = await smartStorage.loadObject(fromID);
        let toObj = await smartStorage.loadObject(toID);
        if (fromObj.availableBalance < amount) {
            await $$.throwError(new Error("Transfer rejected"), "Failing to transfer " + amount + " points", " having only " + fromObj.availableBalance + " from " + fromID + " to " + toID);
        }
        fromObj.availableBalance -= amount;

        if (toObj.availableBalance === undefined || isNaN(toObj.availableBalance)) {
            toObj.availableBalance = 0;
        }

        toObj.availableBalance += amount;
        await smartStorage.updateProperty(fromID, "availableBalance", fromObj.availableBalance);
        await smartStorage.updateProperty(toID, "availableBalance", toObj.availableBalance);
        await systemAudit.smartLog(AUDIT_EVENTS.TRANSFER, {fromID, toID, amount, reason})
        return true;
    }

    this.transferLockedPoints = async function (amount, fromID, toID, reason) {
        amount = MathMoney.normalise(amount);
        let fromObj = await smartStorage.loadObject(fromID);
        let toObj = await smartStorage.loadObject(toID);
        if (fromObj.lockedBalance < amount) {
            throw new Error("Insufficient locked points to transfer");
        }
        fromObj.lockedBalance -= amount;
        toObj.lockedBalance += amount;
        await smartStorage.updateProperty(fromID, "lockedBalance", fromObj.lockedBalance, reason);
        await smartStorage.updateProperty(toID, "lockedBalance", toObj.lockedBalance, reason);
        await systemAudit.smartLog(AUDIT_EVENTS.TRANSFER_LOCKED, {fromID, toID, amount, reason})

        return true;
    }

    this.loginEvent = function (userID, state, reason) {
        systemAudit.smartLog(SYSLOG_EVENTS.LOGIN, {userID, state, reason});
    };

    this.addController = async function (objectId, newController, role) {
        let controllers = await smartStorage.getProperty(objectId, "controllers");
        if (controllers === undefined) {
            controllers = {};
        }
        //only one owner is allowed
        if (role === "owner") {
            for (let controller in controllers) {
                if (controllers[controller] === "owner") {
                    throw new Error("Only one owner is allowed! Delete the current owner before adding a new one!");
                }
            }
        }

        controllers[newController] = role;
        await smartStorage.setProperty(objectId, "controllers", controllers);
    }

    this.deleteController = async function (objectId, controller) {
        let controllers = await smartStorage.getProperty(objectId, "controllers");
        if (controllers === undefined) {
            console.debug("No controllers for object " + objectId);
            return;
        }
        controllers[controller] = undefined;
        delete controllers[controller];
        await smartStorage.setProperty(objectId, "controllers", controllers);
    }

    this.getControllers = async function (objectId) {
        return await smartStorage.getProperty(objectId, "controllers");
    }

    this.hasRole = async function (objectId, controller, role) {
        let controllers = await smartStorage.getProperty(objectId, "controllers");
        if (controllers === undefined) {
            return false;
        }
        return controllers[controller] === role;
    }

    this.getOwner = async function (objectId) {
        let controllers = await smartStorage.getProperty(objectId, "controllers");
        if (controllers === undefined) {
            return undefined;
        }
        for (let controller in controllers) {
            if (controllers[controller] === "owner") {
                return controller;
            }
        }
        return undefined;
    }


    console.debug(">>>>> End initialisation of AssetsMixin", Object.keys(self));

}


module.exports = {
    getAssetsMixin: function (elementStorageStrategy, systemAudit) {
        return new AssetsMixin(elementStorageStrategy, systemAudit);
    }

}
