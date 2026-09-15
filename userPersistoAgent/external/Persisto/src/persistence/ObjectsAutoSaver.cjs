const { getLockManager } = require('./lockUtils.cjs');

function AutoSaverPersistence(storageStrategy, periodicInterval) {
    const useLocking = !!process.env.LOCK_FOLDER;
    const lockManager = getLockManager();

    if (!periodicInterval) {
        periodicInterval = 5000;
    }

    this.init = async function () {
        if (storageStrategy.init && (!storageStrategy.isInitialized || !storageStrategy.isInitialized())) {
            await storageStrategy.init();
        }

        if (useLocking) {
            await lockManager.cleanupStaleLocks();
        }
    }

    this.getNextNumber = async function (itemType) {
        return await storageStrategy.getNextNumber(itemType);
    }

    this.getLogicalTimestamp = async function () {
        return await storageStrategy.getLogicalTimestamp();
    }

    this.createObject = async function (id, obj) {
        return await storageStrategy.createObject(id, obj);
    }

    this.loadObject = async function (id, allowMissing = false) {
        return await storageStrategy.loadObject(id, allowMissing);
    }

    this.objectExists = async function (id) {
        return await storageStrategy.objectExists(id);
    }

    this.getProperty = async function (id, key) {
        return await storageStrategy.getProperty(id, key);
    }

    this.setProperty = this.updateProperty = async function (id, key, value) {
        return await storageStrategy.setProperty(id, key, value);
    }

    this.updateGroupingForFieldChange = async function (typeName, objId, fieldName, oldValue, newValue) {
        return await storageStrategy.updateGroupingForFieldChange(typeName, objId, fieldName, oldValue, newValue);
    }

    this.updateObject = async function (id, values) {
        return await storageStrategy.updateObject(id, values);
    }

    this.preventIndexUpdate = async function (typeName, values, obj) {
        return await storageStrategy.preventIndexUpdate(typeName, values, obj);
    }

    this.updateIndexedField = async function (id, typeName, fieldName, oldValue, newValue) {
        return await storageStrategy.updateIndexedField(id, typeName, fieldName, oldValue, newValue);
    }

    this.keyExistInIndex = async function (typeName, key) {
        return await storageStrategy.keyExistInIndex(typeName, key);
    }

    this.getObjectsIndexValue = async function (typeName) {
        return await storageStrategy.getObjectsIndexValue(typeName);
    }

    this.getIndexedObjectId = async function (typeName, indexValue) {
        return await storageStrategy.getIndexedObjectId(typeName, indexValue);
    }

    this.updateGrouping = async function (typeName, objId) {
        return await storageStrategy.updateGrouping(typeName, objId);
    }

    this.deleteIndexedField = async function (objId, typeName) {
        return await storageStrategy.deleteIndexedField(objId, typeName);
    }

    this.deleteObject = async function (typeName, id) {
        return await storageStrategy.deleteObjectWithType(typeName, id);
    }

    this.removeFromGrouping = async function (typeName, objId) {
        return await storageStrategy.removeFromGrouping(typeName, objId);
    }

    this.hasCreationConflicts = async function (typeName, values) {
        return await storageStrategy.hasCreationConflicts(typeName, values);
    }

    this.createIndex = async function (typeName, fieldName) {
        return await storageStrategy.createIndex(typeName, fieldName);
    }

    this.getAllObjectIds = async function () {
        return await storageStrategy.getAllObjectIds();
    }

    this.getAllObjects = async function (typeName) {
        return await storageStrategy.getAllObjects(typeName);
    }

    this.getAllObjectsData = async function (typeName, sortBy, start, end, descending) {
        return await storageStrategy.getAllObjectsData(typeName, sortBy, start, end, descending);
    }

    this.loadObjectsRange = async function (ids, sortBy, start, end, descending) {
        return await storageStrategy.loadObjectsRange(ids, sortBy, start, end, descending);
    }

    this.getObjectByField = async function (typeName, fieldName, fieldValue, allowMissing) {
        return await storageStrategy.getObjectByField(typeName, fieldName, fieldValue, allowMissing);
    }

    this.createGrouping = async function (groupingName, typeName, fieldName) {
        return await storageStrategy.createGrouping(groupingName, typeName, fieldName);
    }

    this.getGroupingByField = async function (groupingName, fieldValue) {
        return await storageStrategy.getGroupingByField(groupingName, fieldValue);
    }

    this.getGroupingObjectsByField = async function (groupingName, fieldValue, sortBy, start, end, descending) {
        return await storageStrategy.getGroupingObjectsByField(groupingName, fieldValue, sortBy, start, end, descending);
    }

    this.createRel = async function (joinName, leftType, rightType) {
        return await storageStrategy.createRel(joinName, leftType, rightType);
    }

    this.addRel = async function (joinName, leftId, rightId) {
        return await storageStrategy.addRel(joinName, leftId, rightId);
    }

    this.removeRel = async function (joinName, leftId, rightId) {
        return await storageStrategy.removeRel(joinName, leftId, rightId);
    }

    this.getRelatedObjects = async function (joinName, objectId, direction) {
        return await storageStrategy.getRelatedObjects(joinName, objectId, direction);
    }

    this.getRelatedObjectsData = async function (joinName, objectId, direction, sortBy, start, end, descending) {
        return await storageStrategy.getRelatedObjectsData(joinName, objectId, direction, sortBy, start, end, descending);
    }

    this.removeObjectFromAllRels = async function (objectId) {
        return await storageStrategy.removeObjectFromAllRels(objectId);
    }

    this.select = async function (typeName, filters = {}, sortBy = null, start = 0, end = null, descending = false) {
        return await storageStrategy.select(typeName, filters, sortBy, start, end, descending);
    }

    async function performSaveWithLock() {
        const lockName = 'critical_section';
        let lockCreated = false;

        try {
            if (useLocking && await lockManager.isLockActive(lockName)) {
                return;
            }

            if (useLocking) {
                await lockManager.createLock(lockName);
                lockCreated = true;
            }

            await storageStrategy.saveAll();
        } catch (error) {
            console.error('Error during periodic save:', error);
        } finally {
            if (lockCreated && useLocking) {
                await lockManager.removeLock(lockName);
            }
        }
    }

    async function performSimpleSave() {
        try {
            await storageStrategy.saveAll();
        } catch (error) {
            console.error('Error during periodic save:', error);
        }
    }

    const saveFunction = useLocking ? performSaveWithLock : performSimpleSave;
    let intervalId = setInterval(saveFunction, periodicInterval);

    this.shutDown = async function () {
        clearInterval(intervalId);

        if (useLocking) {
            await performSaveWithLock();
        } else {
            await performSimpleSave();
        }
    }

    this.forceSave = async function () {
        if (useLocking) {
            await performSaveWithLock();
        } else {
            await performSimpleSave();
        }
    }
}

module.exports = {
    getAutoSaverPersistence: async function (storageStrategy) {
        if (!storageStrategy) {
            storageStrategy = require("./strategies/SimpleFSStorageStrategy.cjs").getSimpleFSStorageStrategy();
            await storageStrategy.init();
        }
        let autoSaver = new AutoSaverPersistence(storageStrategy);
        await autoSaver.init()
        return autoSaver;
    }
};
