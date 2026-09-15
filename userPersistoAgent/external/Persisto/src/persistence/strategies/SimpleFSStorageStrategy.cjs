let fs = require("fs").promises;
let path = require("path");
//let coreUtils = require("../util/sopUtil.js");
const FILE_PATH_SEPARATOR = ".";

function makeSpecialName(typeName, fieldName) {
    return typeName + FILE_PATH_SEPARATOR + fieldName;
}

function SimpleFSStorageStrategy() {
    if (process.env.PERSISTENCE_FOLDER === undefined) {
        console.error("PERSISTENCE_FOLDER environment variable is not set. Please set it to the path where the logs should be stored. Defaults to './work_space_data/'");
        process.env.PERSISTENCE_FOLDER = "./work_space_data/"
    }

    fs.mkdir(process.env.PERSISTENCE_FOLDER, { recursive: true }).catch(console.error);

    let cache = {};
    let timestampCache = {};
    let modified = {};
    let _indexes = {};
    let _groupings = {};
    let _joins = {};
    let alreadyInitialized = false;
    let self = this;

    this.init = async function () {
        if (alreadyInitialized) {
            await $$.throwError(new Error("SimpleFSStorageStrategy already initialised!"));
        }
        alreadyInitialized = true;

        try {
            await fs.mkdir(process.env.PERSISTENCE_FOLDER, { recursive: true });
        } catch (error) {
            console.error("Error creating folder", process.env.PERSISTENCE_FOLDER, error);
        }

        // Initialize system object
        let systemObject = await this.loadObjectFromDisk("system", true);
        if (!systemObject || !systemObject.currentIDNumber) {
            systemObject = await this.createObject("system", { currentIDNumber: 1, currentClockTick: 0 });
        }
        cache["system"] = systemObject;
    }

    this.isInitialized = function () {
        return alreadyInitialized;
    }

    function getFilePath(input) {
        const regex = /^[a-zA-Z0-9_.]+$/;
        if (!regex.test(input)) {
            throw new Error("For security reasons only letters and numbers are allowed in object IDs!" + " Provided id is: " + input);
        }
        return path.join(process.env.PERSISTENCE_FOLDER, input);
    }

    this.loadObjectFromDisk = async function (id, allowMissing) {
        try {
            if (!id) {
                await $$.throwError("An object identifier is required for loading!" + " Provided id is: " + id);
                return undefined;
            }
            const filePath = getFilePath(id);
            const data = await fs.readFile(filePath, 'utf8');
            return JSON.parse(data);
        } catch (error) {
            if (!allowMissing) {
                await $$.throwError(error, `Error loading object with id [${id}]`, "Allow missing is:", typeof allowMissing, allowMissing, "Error is:");
            }
            return undefined;
        }
    }

    function isSpecialObject(id) {
        // Check if it's a system object
        if (id === "system") {
            return true;
        }

        // Check if it's an index (contains a dot but doesn't follow the regular object pattern)
        // Regular objects follow pattern: TYPENAME.NUMBER (e.g., USER.1, USER.123)
        // Indexes follow pattern: typename.fieldname (e.g., user.name, ticket.id)
        if (id.includes(FILE_PATH_SEPARATOR)) {
            // If it has a dot, check if it's a regular object ID (UPPERCASE.NUMBER)
            const parts = id.split(FILE_PATH_SEPARATOR);
            if (parts.length === 2) {
                const [typePart, idPart] = parts;
                // Regular objects have uppercase type and numeric ID
                if (typePart === typePart.toUpperCase() && /^\d+$/.test(idPart)) {
                    return false; // This is a regular object, not special
                }
            }
            return true; // Other dot-containing objects are special (indexes)
        }

        // Check if it's a grouping
        for (let typeName in _groupings) {
            let allGroupings = _groupings[typeName];
            if (allGroupings && allGroupings.length > 0) {
                for (let i = 0; i < allGroupings.length; i++) {
                    if (allGroupings[i].groupingName === id) {
                        return true;
                    }
                }
            }
        }

        // Check if it's a rel/join related object
        for (let joinName in _joins) {
            let joinConfig = _joins[joinName];
            if (id === joinConfig.leftToRight || id === joinConfig.rightToLeft) {
                return true;
            }
        }

        return false;
    }

    async function loadWithCache(id, allowMissing = false) {
        if (!cache[id]) {
            cache[id] = await self.loadObjectFromDisk(id, allowMissing);
            timestampCache[id] = await self.getTimestamp(id);
        }

        return cache[id];
    }

    async function loadWithCacheCopy(id, allowMissing = false) {
        let obj = await loadWithCache(id, allowMissing);

        // For regular objects (not indexes, groupings, or rels), return a deep copy
        // to prevent mutations affecting the cached version
        if (obj && !isSpecialObject(id)) {
            return structuredClone(obj);
        }

        return obj;
    }

    function setForSave(id) {
        modified[id] = true;
    }

    this.loadObject = async function (id, allowMissing = false) {
        return await loadWithCacheCopy(id, allowMissing);
    }

    this.objectExists = async function (id) {
        if (cache[id]) {
            return true;
        }
        try {
            const filePath = getFilePath(id);
            await fs.access(filePath);
            return true;
            // eslint-disable-next-line no-unused-vars
        } catch (error) {
            //console.debug(">>> Object with ID", id, "does not exist in file at path: " + getFilePath(id) + " " + error.message + " CWD is: " + process.cwd());
            return false;
        }
    }

    this.storeObject = async function (id, obj) {
        //console.debug(">>> Storing object with ID", id, "and value", obj);
        try {
            const filePath = getFilePath(id);
            await fs.writeFile(filePath, JSON.stringify(obj, null, 2), 'utf8');
        } catch (error) {
            await $$.throwError(error, `Error storing object [${id}] Error is:` + error.message);
        }
    };

    this.deleteObject = async function (id) {
        try {
            const filePath = getFilePath(id);
            await fs.unlink(filePath);
        } catch (error) {
            await $$.throwError(error, `Error deleting object [${id}] Error is:` + error.message);
        }
    }

    this.getTimestamp = async function (id) {
        try {
            const filePath = getFilePath(id);
            const stats = await fs.stat(filePath);
            return stats.mtimeMs;
            // eslint-disable-next-line no-unused-vars
        } catch (error) {
            //await $$.throwError(error, `Error getting timestamp for object [${id}] Error is:` + error.message);
            return undefined;
        }
    }

    this.listAllObjects = async function () {
        try {
            const files = await fs.readdir(process.env.PERSISTENCE_FOLDER);
            return files.filter(file => {
                // Filter out hidden files and directories
                return !file.startsWith('.') && file.match(/^[a-zA-Z0-9_.]+$/);
            });
        } catch (error) {
            console.error("Error listing objects in folder", process.env.PERSISTENCE_FOLDER, error);
            return [];
        }
    }

    this.getNextNumber = async function (itemType) {
        let systemObject = await loadWithCache("system");
        if (!itemType) {
            itemType = "default";
        }
        let nextNumber = systemObject[itemType];
        if (typeof nextNumber === "undefined") {
            nextNumber = 0;
        }
        nextNumber++;
        systemObject[itemType] = nextNumber;

        setForSave("system");
        return nextNumber;
    }

    this.getLogicalTimestamp = async function () {
        let systemObject = await loadWithCache("system");
        systemObject.currentClockTick++;
        setForSave("system");
        return systemObject.currentClockTick;
    }

    this.createObject = async function (id, obj) {
        if (!id) {
            throw new Error("ID is required for creating an object!" + " provided ID: " + id);
        }
        cache[id] = await this.loadObjectFromDisk(id, true);
        if (cache[id]) {
            await $$.throwError(new Error("Object with ID " + id + " already exists!"));
        }
        cache[id] = obj;
        obj.id = id;
        setForSave(id);

        timestampCache[id] = await this.getTimestamp(id);

        // Return a deep copy to prevent mutations from affecting the cached version
        return structuredClone(obj);
    }

    this.getProperty = async function (id, key) {
        let obj = await loadWithCache(id);
        return obj[key];
    }

    this.setProperty = this.updateProperty = async function (id, key, value) {
        let obj = await loadWithCache(id);
        obj[key] = value;
        setForSave(id);
    }

    this.updateGroupingForFieldChange = async function (typeName, objId, fieldName, oldValue, newValue) {
        let allGroupings = _groupings[typeName];
        if (!allGroupings || allGroupings.length === 0) {
            return;
        }

        for (let i = 0; i < allGroupings.length; i++) {
            let groupingName = allGroupings[i].groupingName;
            let groupingFieldName = allGroupings[i].fieldName;

            // Only process if this grouping is for the field that changed
            if (groupingFieldName === fieldName) {
                let grouping = await loadWithCache(groupingName);

                // Initialize itemSets if not present
                if (!grouping.itemSets) {
                    grouping.itemSets = {};
                    // Initialize sets for existing items
                    for (let fieldVal in grouping.items) {
                        grouping.itemSets[fieldVal] = new Set(grouping.items[fieldVal]);
                    }
                }

                // Remove from old value's grouping (if oldValue exists)
                if (oldValue !== undefined && grouping.items[oldValue]) {
                    if (!grouping.itemSets[oldValue] || !(grouping.itemSets[oldValue] instanceof Set)) {
                        grouping.itemSets[oldValue] = new Set(grouping.items[oldValue]);
                    }

                    if (grouping.itemSets[oldValue].has(objId)) {
                        grouping.items[oldValue] = grouping.items[oldValue].filter(id => id !== objId);
                        grouping.itemSets[oldValue].delete(objId);

                        if (grouping.items[oldValue].length === 0) {
                            delete grouping.items[oldValue];
                            delete grouping.itemSets[oldValue];
                        }
                        setForSave(groupingName);
                    }
                }

                // Add to new value's grouping (if newValue exists)
                if (newValue !== undefined) {
                    if (!grouping.items[newValue]) {
                        grouping.items[newValue] = [];
                    }
                    if (!grouping.itemSets[newValue] || !(grouping.itemSets[newValue] instanceof Set)) {
                        grouping.itemSets[newValue] = new Set(grouping.items[newValue]);
                    }

                    // O(1) check using Set
                    if (!grouping.itemSets[newValue].has(objId)) {
                        grouping.items[newValue].push(objId);
                        grouping.itemSets[newValue].add(objId);
                        setForSave(groupingName);
                    }
                }
            }
        }
    }

    this.updateObject = async function (id, values) {
        let obj = await loadWithCache(id);

        // get the original values from storage to detect changes
        let originalObj = await this.loadObjectFromDisk(id, true);
        if (!originalObj) {
            // If no storage version exists, we can't detect changes
            // This can happen for objects created through alternative paths
            originalObj = JSON.parse(JSON.stringify(obj));
        }

        // Check for grouping field changes by comparing with original storage values
        for (let key in values) {
            if (originalObj[key] !== values[key]) {
                // Check if this field change affects any groupings
                for (let typeName in _groupings) {
                    let allGroupings = _groupings[typeName];
                    if (allGroupings && allGroupings.length > 0) {
                        for (let i = 0; i < allGroupings.length; i++) {
                            let fieldName = allGroupings[i].fieldName;
                            if (fieldName === key) {
                                let oldValue = originalObj[key];
                                let newValue = values[key];
                                await this.updateGroupingForFieldChange(typeName, id, fieldName, oldValue, newValue);
                            }
                        }
                    }
                }
            }
            obj[key] = values[key];
        }

        setForSave(id);
    }

    this.preventIndexUpdate = async function (typeName, values, obj) {
        let indexFieldName = _indexes[typeName];
        if (typeof indexFieldName === "undefined") {
            return values;
        }
        values[indexFieldName] = obj[indexFieldName];
        return values;
    }

    this.updateIndexedField = async function (id, typeName, fieldName, oldValue, newValue) {
        let obj = await loadWithCache(id);
        let indexFieldName = _indexes[typeName];
        if (!indexFieldName) {
            return; //no index exists
        }
        else {
            if (!fieldName) {
                fieldName = indexFieldName;
                oldValue = undefined;
                newValue = obj[fieldName];
            }
        }
        if (fieldName !== indexFieldName) {
            await $$.throwError(new Error("Field " + fieldName + " is not indexed for type " + typeName));
        }

        //console.debug(">>> Updating field " + fieldName + " for type " + typeName + " from " + oldValue + " to " + newValue);
        if (oldValue === newValue) {
            return; //nothing to do
        }

        let indexId = makeSpecialName(typeName, indexFieldName);
        let index = await loadWithCache(indexId);

        if (index.ids[newValue] !== undefined) {
            await $$.throwError(new Error("Index for field " + fieldName + " already exists for value " + newValue));
        }
        //console.debug(">>> Updating index" + fieldName + " for type " + typeName + " from " + oldValue + " to " + newValue);
        if (oldValue !== newValue) {
            if (oldValue !== undefined) {
                delete index.ids[oldValue];
            }
        }
        index.ids[newValue] = id;
        setForSave(indexId);
        obj[fieldName] = newValue;
        setForSave(id);
    }

    this.keyExistInIndex = async function (typeName, key) {
        let indexFieldName = _indexes[typeName];
        if (!indexFieldName) {
            return false; //no index exists, so key cannot exist
        }

        let indexId = makeSpecialName(typeName, indexFieldName);
        let index = await loadWithCache(indexId);
        //console.debug(">>> Checking if key exists in index", key, "for type", typeName, "index is", index);
        return index.ids[key] !== undefined;
    }

    this.getObjectsIndexValue = async function (typeName) {
        let indexFieldName = _indexes[typeName];
        if (!indexFieldName) {
            return undefined; //no index exists, so key cannot exist
        }

        let indexId = makeSpecialName(typeName, indexFieldName);
        let index = await loadWithCache(indexId);
        //console.debug(">>> Getting objects for key", key, "in index", typeName, "index is", index);
        return Object.keys(index.ids)
    }

    this.getIndexedObjectId = async function (typeName, indexValue) {
        let indexFieldName = _indexes[typeName];
        if (!indexFieldName) {
            return undefined;
        }
        let indexId = makeSpecialName(typeName, indexFieldName);
        let index = await loadWithCache(indexId, true);
        if (!index || !index.ids) {
            return undefined;
        }
        return index.ids[indexValue];
    }

    this.updateGrouping = async function (typeName, objId) {
        let obj = await loadWithCache(objId);
        let allGroupings = _groupings[typeName];
        if (allGroupings && allGroupings.length !== 0) {
            for (let i = 0; i < allGroupings.length; i++) {
                let groupingName = allGroupings[i].groupingName;
                //console.debug(">>> Found grouping" + groupingName + " grouped by field " + _groupings[typeName].fieldName + " for type " + typeName);
                let fieldName = allGroupings[i].fieldName;
                let grouping = await loadWithCache(groupingName);

                let fieldValue = obj[fieldName];

                // Initialize arrays and sets if they don't exist
                if (!grouping.items[fieldValue]) {
                    grouping.items[fieldValue] = [];
                }
                if (!grouping.itemSets) {
                    grouping.itemSets = {};
                }
                if (!grouping.itemSets[fieldValue] || !(grouping.itemSets[fieldValue] instanceof Set)) {
                    grouping.itemSets[fieldValue] = new Set(grouping.items[fieldValue]);
                }

                // O(1) check using Set instead of O(n) array scan
                if (!grouping.itemSets[fieldValue].has(objId)) {
                    grouping.items[fieldValue].push(objId);
                    grouping.itemSets[fieldValue].add(objId);
                    setForSave(groupingName);
                }
            }
        }
    }

    this.deleteIndexedField = async function (objId, typeName) {
        let indexFieldName = _indexes[typeName]
        if (!indexFieldName) {
            return;
        }
        let indexId = makeSpecialName(typeName, indexFieldName);
        let indexObj = await loadWithCache(indexId, true);
        if (!indexObj || !indexObj.ids) {
            return;
        }

        let changed = false;
        let obj = await loadWithCache(objId, true);

        if (obj && obj[indexFieldName] !== undefined && indexObj.ids[obj[indexFieldName]] !== undefined) {
            delete indexObj.ids[obj[indexFieldName]];
            changed = true;
        } else {
            for (let [key, value] of Object.entries(indexObj.ids)) {
                if (value === objId) {
                    delete indexObj.ids[key];
                    changed = true;
                }
            }
        }

        if (changed) {
            setForSave(indexId);
        }
    }

    this.deleteObjectWithType = async function (typeName, id) {
        await this.deleteIndexedField(id, typeName);
        await this.removeFromGrouping(typeName, id);
        await this.removeObjectFromAllRels(id);
        delete cache[id];
        delete modified[id];
        if (await this.objectExists(id)) {
            await this.deleteObject(id);
        }
    }

    this.removeFromGrouping = async function (typeName, objId) {
        let obj = await loadWithCache(objId, true);
        let myGroupings = _groupings[typeName];
        if (myGroupings && myGroupings.length !== 0) {
            for (let i = 0; i < myGroupings.length; i++) {
                let groupingName = myGroupings[i].groupingName;
                let fieldName = myGroupings[i].fieldName;
                let grouping = await loadWithCache(groupingName);
                if (!grouping || !grouping.items) {
                    continue;
                }

                if (!grouping.itemSets) {
                    grouping.itemSets = {};
                    for (let fieldVal in grouping.items) {
                        grouping.itemSets[fieldVal] = new Set(grouping.items[fieldVal]);
                    }
                }

                let changed = false;

                if (obj && obj[fieldName] !== undefined) {
                    let fieldValue = obj[fieldName];
                    if (!grouping.items[fieldValue]) {
                        continue;
                    }
                    if (!grouping.itemSets[fieldValue] || !(grouping.itemSets[fieldValue] instanceof Set)) {
                        grouping.itemSets[fieldValue] = new Set(grouping.items[fieldValue]);
                    }

                    if (grouping.itemSets[fieldValue].has(objId)) {
                        grouping.items[fieldValue] = grouping.items[fieldValue].filter(id => id !== objId);
                        grouping.itemSets[fieldValue].delete(objId);
                        changed = true;

                        if (grouping.items[fieldValue].length === 0) {
                            delete grouping.items[fieldValue];
                            delete grouping.itemSets[fieldValue];
                        }
                    }
                } else {
                    for (let [fieldValue, ids] of Object.entries(grouping.items)) {
                        if (!Array.isArray(ids)) {
                            continue;
                        }
                        if (!grouping.itemSets[fieldValue] || !(grouping.itemSets[fieldValue] instanceof Set)) {
                            grouping.itemSets[fieldValue] = new Set(ids);
                        }
                        if (grouping.itemSets[fieldValue].has(objId)) {
                            grouping.items[fieldValue] = ids.filter(id => id !== objId);
                            grouping.itemSets[fieldValue].delete(objId);
                            changed = true;

                            if (grouping.items[fieldValue].length === 0) {
                                delete grouping.items[fieldValue];
                                delete grouping.itemSets[fieldValue];
                            }
                        }
                    }
                }

                if (changed) {
                    setForSave(groupingName);
                }
            }
        }
    }

    this.hasCreationConflicts = async function (typeName, values) {
        let indexFieldName = _indexes[typeName];
        if (indexFieldName) {
            let indexId = makeSpecialName(typeName, indexFieldName);
            let index = await loadWithCache(indexId);
            if (index.ids[values[indexFieldName]] !== undefined) {
                console.debug(">>> Found conflict for type " + typeName, "with value", values[indexFieldName], "and in index ", index.ids[values[indexFieldName]]);
                return true;
            }
        }
        return false;
    }

    this.createIndex = async function (typeName, fieldName) {
        if (_indexes[typeName]) {
            await $$.throwError(new Error("Index for type " + typeName + " already exists!"));
        }
        _indexes[typeName] = fieldName;

        let objId = makeSpecialName(typeName, fieldName);
        let obj = await loadWithCache(objId, true);
        if (!obj) {
            await this.createObject(objId, { ids: {} });
            setForSave(objId);
        }

        // Retroactively populate the index with existing objects
        await populateIndexWithExistingObjects(typeName, fieldName, objId);
    }

    this.getAllObjectIds = async function () {
        // Get all object IDs from both cache and disk storage
        const diskObjectIds = await this.listAllObjects();
        const cacheObjectIds = Object.keys(cache);

        // Combine both lists and remove duplicates
        const allObjectIds = [...new Set([...diskObjectIds, ...cacheObjectIds])];
        return allObjectIds;
    }

    async function populateIndexWithExistingObjects(typeName, fieldName, indexId) {
        try {
            // Get all object IDs from both cache and storage
            const allObjectIds = await self.getAllObjectIds();

            // Filter objects to only include those that belong to the specific type
            const typeRelatedIds = allObjectIds.filter(id => {
                // if id is lowercase, return false
                if (id === id.toLowerCase()) {
                    return false;
                }

                const typeNameUpper = typeName.toUpperCase();
                const idUpper = id.toUpperCase();

                // Check if ID starts with type name followed by a dot (e.g., "TICKET.1", "USER.123")
                if (idUpper.startsWith(typeNameUpper + ".")) {
                    return true;
                }

                // Check if ID exactly matches type name (for singleton objects)
                if (idUpper === typeNameUpper) {
                    return true;
                }

                return false;
            });

            let index = await loadWithCache(indexId);
            let indexUpdated = false;

            for (const objectId of typeRelatedIds) {
                try {
                    const obj = await loadWithCache(objectId, true);

                    if (obj && obj[fieldName] !== undefined) {
                        // Check if this object already exists in the index
                        if (index.ids[obj[fieldName]] === undefined) {
                            // Check for conflicts - if value already exists for different object
                            const existingObjectId = index.ids[obj[fieldName]];
                            if (existingObjectId && existingObjectId !== objectId) {
                                console.warn(`Index conflict: Field ${fieldName} value ${obj[fieldName]} already exists for object ${existingObjectId}, skipping object ${objectId}`);
                                continue;
                            }
                            index.ids[obj[fieldName]] = objectId;
                            indexUpdated = true;

                        }
                    }
                } catch (error) {
                    // Skip objects that can't be loaded
                    console.debug(`Skipping object ${objectId} during index population: ${error.message}`);
                }
            }

            if (indexUpdated) {
                setForSave(indexId);
            }
        } catch (error) {
            console.error(`Error populating index ${typeName}.${fieldName}:`, error);
        }
    }

    this.getAllObjects = async function (typeName) {
        let fieldName = _indexes[typeName];
        let objId = makeSpecialName(typeName, fieldName);
        let obj = await loadWithCache(objId);
        return Object.values(obj.ids);
    }

    this.getAllObjectsData = async function (typeName, sortBy, start, end, descending) {
        let ids = await this.getAllObjects(typeName);
        return await this.loadObjectsRange(ids, sortBy, start, end, descending);
    }

    this.loadObjectsRange = async function (ids, sortBy, start, end, descending) {
        const loaded = await Promise.all(
            ids.map(async (id) => {
                try {
                    return await this.loadObject(id, true);
                } catch {
                    return undefined;
                }
            })
        );
        let objects = loaded.filter(Boolean);
        if (sortBy) {
            objects.sort((a, b) => {
                const aVal = a[sortBy];
                const bVal = b[sortBy];

                const aInvalid = aVal === undefined || aVal === null || typeof aVal === 'object';
                const bInvalid = bVal === undefined || bVal === null || typeof bVal === 'object';

                if (aInvalid && bInvalid) return 0;
                if (aInvalid) return 1;
                if (bInvalid) return -1;

                let result;

                if (typeof aVal === 'string' && typeof bVal === 'string') {
                    result = aVal.localeCompare(bVal); // ascending by default
                } else {
                    result = aVal - bVal; // assumes numeric
                }

                return descending ? -result : result;
            });
        }
        return objects.slice(start, end);
    }

    this.getObjectByField = async function (typeName, fieldName, fieldValue, allowMissing) {
        if (!fieldName) {
            fieldName = _indexes[typeName];
        }
        if (!fieldName) {
            return undefined;
        }

        let objId = makeSpecialName(typeName, fieldName);
        let index = await loadWithCache(objId);
        let indexValueAsId = index.ids[fieldValue];
        if (indexValueAsId === undefined) {
            return undefined;    // Periodic saving functionality

        }
        return await this.loadObject(indexValueAsId, allowMissing);
    }

    this.createGrouping = async function (groupingName, typeName, fieldName) {
        if (!_groupings[typeName]) {
            _groupings[typeName] = [];
        }
        _groupings[typeName].push({ groupingName, fieldName });

        let obj = await loadWithCache(groupingName, true);
        if (!obj) {
            await this.createObject(groupingName, { items: {}, itemSets: {} });
            setForSave(groupingName);
        }

        // Retroactively populate the grouping with existing objects
        await populateGroupingWithExistingObjects(typeName, fieldName, groupingName);
    }

    async function populateGroupingWithExistingObjects(typeName, fieldName, groupingName) {
        try {
            // Get all object IDs from both cache and storage
            const allObjectIds = await self.getAllObjectIds();

            // Filter objects that belong to this type
            const typeRelatedIds = allObjectIds.filter(id => {
                // if id is lowercase, return false
                if (id === id.toLowerCase()) {
                    return false;
                }

                const typeNameUpper = typeName.toUpperCase();
                const idUpper = id.toUpperCase();

                // Check if ID starts with type name followed by a dot (e.g. "USER.123")
                if (idUpper.startsWith(typeNameUpper + ".")) {
                    return true;
                }

                // Check if ID exactly matches type name (for singleton objects)
                if (idUpper === typeNameUpper) {
                    return true;
                }

                return false;
            });

            let grouping = await loadWithCache(groupingName);
            let groupingUpdated = false;

            for (const objectId of typeRelatedIds) {
                try {
                    const obj = await loadWithCache(objectId, true);
                    if (obj && obj[fieldName] !== undefined) {
                        const fieldValue = obj[fieldName];

                        // Initialize the array for this field value if it doesn't exist
                        if (!grouping.items[fieldValue]) {
                            grouping.items[fieldValue] = [];
                        }

                        // Initialize itemSets if not present
                        if (!grouping.itemSets) {
                            grouping.itemSets = {};
                            for (let fieldVal in grouping.items) {
                                grouping.itemSets[fieldVal] = new Set(grouping.items[fieldVal]);
                            }
                        }
                        if (!grouping.itemSets[fieldValue] || !(grouping.itemSets[fieldValue] instanceof Set)) {
                            grouping.itemSets[fieldValue] = new Set(grouping.items[fieldValue]);
                        }

                        // Add the object ID if it's not already in the grouping (O(1) check using Set)
                        if (!grouping.itemSets[fieldValue].has(objectId)) {
                            grouping.items[fieldValue].push(objectId);
                            grouping.itemSets[fieldValue].add(objectId);
                            groupingUpdated = true;
                        }
                    }
                } catch (error) {
                    // Skip objects that can't be loaded
                    console.debug(`Skipping object ${objectId} during grouping population: ${error.message}`);
                }
            }

            if (groupingUpdated) {
                setForSave(groupingName);
            }
        } catch (error) {
            console.error(`Error populating grouping ${groupingName}:`, error);
        }
    }

    this.getGroupingByField = async function (groupingName, fieldValue) {
        let grouping = await loadWithCache(groupingName);
        return grouping.items[fieldValue] || [];
    }

    this.getGroupingObjectsByField = async function (groupingName, fieldValue, sortBy, start, end, descending) {
        let grouping = await loadWithCache(groupingName);
        let ids = grouping.items[fieldValue];
        if (!ids) {
            return [];
        }
        return await this.loadObjectsRange(ids, sortBy, start, end, descending);
    }

    this.saveAll = async function () {
        for (let id in modified) {
            delete modified[id];
            await this.storeObject(id, cache[id]);
            timestampCache[id] = await this.getTimestamp(id);
        }
    }

    this.forceSave = async function () {
        await this.saveAll();
    }

    this.getModified = function () {
        return Object.keys(modified);
    }

    this.createRel = async function (joinName, leftType, rightType) {
        if (_joins[joinName]) {
            await $$.throwError(new Error("Rel " + joinName + " already exists!"));
        }

        _joins[joinName] = {
            leftType: leftType,
            rightType: rightType,
            leftToRight: joinName + "_left_to_right",
            rightToLeft: joinName + "_right_to_left"
        };

        // Create storage objects for both directions
        let leftToRightId = _joins[joinName].leftToRight;
        let rightToLeftId = _joins[joinName].rightToLeft;

        let leftToRightObj = await loadWithCache(leftToRightId, true);
        if (!leftToRightObj) {
            await this.createObject(leftToRightId, { joins: {} });
        }

        let rightToLeftObj = await loadWithCache(rightToLeftId, true);
        if (!rightToLeftObj) {
            await this.createObject(rightToLeftId, { joins: {} });
        }

        await populateRelWithExistingObjects(joinName, leftType, rightType);
    }

    this.addRel = async function (joinName, leftId, rightId) {
        if (!_joins[joinName]) {
            await $$.throwError(new Error("Rel " + joinName + " does not exist!"));
        }

        let config = _joins[joinName];
        let leftToRight = await loadWithCache(config.leftToRight);
        let rightToLeft = await loadWithCache(config.rightToLeft);

        if (!leftToRight.joins[leftId]) {
            leftToRight.joins[leftId] = [];
        }
        if (leftToRight.joins[leftId].indexOf(rightId) === -1) {
            leftToRight.joins[leftId].push(rightId);
            setForSave(config.leftToRight);
        }

        if (!rightToLeft.joins[rightId]) {
            rightToLeft.joins[rightId] = [];
        }
        if (rightToLeft.joins[rightId].indexOf(leftId) === -1) {
            rightToLeft.joins[rightId].push(leftId);
            setForSave(config.rightToLeft);
        }
    }

    this.removeRel = async function (joinName, leftId, rightId) {
        if (!_joins[joinName]) {
            await $$.throwError(new Error("Rel " + joinName + " does not exist!"));
        }

        let config = _joins[joinName];
        let leftToRight = await loadWithCache(config.leftToRight);
        let rightToLeft = await loadWithCache(config.rightToLeft);

        if (leftToRight.joins[leftId]) {
            let index = leftToRight.joins[leftId].indexOf(rightId);
            if (index !== -1) {
                leftToRight.joins[leftId].splice(index, 1);
                if (leftToRight.joins[leftId].length === 0) {
                    delete leftToRight.joins[leftId];
                }
                setForSave(config.leftToRight);
            }
        }

        if (rightToLeft.joins[rightId]) {
            let index = rightToLeft.joins[rightId].indexOf(leftId);
            if (index !== -1) {
                rightToLeft.joins[rightId].splice(index, 1);
                if (rightToLeft.joins[rightId].length === 0) {
                    delete rightToLeft.joins[rightId];
                }
                setForSave(config.rightToLeft);
            }
        }
    }

    this.getRelatedObjects = async function (joinName, objectId, direction) {
        if (!_joins[joinName]) {
            await $$.throwError(new Error("Rel " + joinName + " does not exist!"));
        }

        let config = _joins[joinName];
        let mappingId;

        if (direction === "left_to_right") {
            mappingId = config.leftToRight;
        } else if (direction === "right_to_left") {
            mappingId = config.rightToLeft;
        } else {
            await $$.throwError(new Error("Invalid direction. Use 'left_to_right' or 'right_to_left'"));
        }

        let mapping = await loadWithCache(mappingId);
        return mapping.joins[objectId] || [];
    }

    this.getRelatedObjectsData = async function (joinName, objectId, direction, sortBy, start, end, descending) {
        let joinedIds = await this.getRelatedObjects(joinName, objectId, direction);
        if (joinedIds.length === 0) {
            return [];
        }
        return await this.loadObjectsRange(joinedIds, sortBy, start, end, descending);
    }

    this.removeObjectFromAllRels = async function (objectId) {
        for (let joinName in _joins) {
            let config = _joins[joinName];

            let leftToRight = await loadWithCache(config.leftToRight);
            if (leftToRight.joins[objectId]) {
                let joinedIds = [...leftToRight.joins[objectId]];
                for (let joinedId of joinedIds) {
                    await this.removeRel(joinName, objectId, joinedId);
                }
            }

            // Check and remove from right side
            let rightToLeft = await loadWithCache(config.rightToLeft);
            if (rightToLeft.joins[objectId]) {
                let joinedIds = [...rightToLeft.joins[objectId]];
                for (let joinedId of joinedIds) {
                    await this.removeRel(joinName, joinedId, objectId);
                }
            }
        }
    }

    this.select = async function (typeName, filters = {}, sortBy, start = 0, end, descending = false) {
        try {
            // Get all objects of the specified type
            let ids = await this.getAllObjects(typeName);
            const loaded = await Promise.all(
                ids.map(async (id) => {
                    try {
                        return await this.loadObject(id, true);
                    } catch {
                        return undefined;
                    }
                })
            );
            let objects = loaded.filter(Boolean);

            // Apply filters
            if (filters && Object.keys(filters).length > 0) {
                objects = this.applyFilters(objects, filters);
            }

            // Apply sorting
            if (sortBy) {
                objects = this.applySorting(objects, sortBy, descending);
            }

            // Apply pagination
            if (end === null) {
                end = objects.length;
            }

            return {
                objects: objects.slice(start, end),
                totalCount: objects.length,
                filteredCount: objects.length,
                pagination: {
                    start: start,
                    end: Math.min(end, objects.length),
                    hasMore: end < objects.length,
                    totalPages: end > start ? Math.ceil(objects.length / (end - start)) : 1
                }
            };
        } catch (error) {
            console.error(`Error in select for type ${typeName}:`, error);
            throw error;
        }
    }

    this.applyFilters = function (objects, filters) {
        return objects.filter(obj => {
            return this.evaluateFilters(obj, filters);
        });
    }

    this.evaluateFilters = function (obj, filters) {
        // Handle logical operators
        if (filters.$and && Array.isArray(filters.$and)) {
            return filters.$and.every(condition => this.evaluateFilters(obj, condition));
        }

        if (filters.$or && Array.isArray(filters.$or)) {
            return filters.$or.some(condition => this.evaluateFilters(obj, condition));
        }

        if (filters.$not) {
            return !this.evaluateFilters(obj, filters.$not);
        }

        // Handle field-based filters
        for (let field in filters) {
            if (field.startsWith('$')) {
                continue; // Skip logical operators already handled
            }

            let fieldValue = this.getNestedProperty(obj, field);
            let condition = filters[field];

            if (!this.evaluateFieldCondition(fieldValue, condition)) {
                return false;
            }
        }

        return true;
    }

    this.getNestedProperty = function (obj, path) {
        return path.split('.').reduce((current, key) => {
            return current && current[key] !== undefined ? current[key] : undefined;
        }, obj);
    }

    this.evaluateFieldCondition = function (fieldValue, condition) {
        // Direct equality check
        if (typeof condition !== 'object' || condition === null) {
            return this.compareValues(fieldValue, condition, '$eq');
        }

        // Handle operator-based conditions
        for (let operator in condition) {
            let expectedValue = condition[operator];

            if (!this.compareValues(fieldValue, expectedValue, operator)) {
                return false;
            }
        }

        return true;
    }

    this.compareValues = function (fieldValue, expectedValue, operator) {
        switch (operator) {
            case '$eq':
                return fieldValue === expectedValue;
            case '$ne':
                return fieldValue !== expectedValue;
            case '$gt':
                return fieldValue > expectedValue;
            case '$gte':
                return fieldValue >= expectedValue;
            case '$lt':
                return fieldValue < expectedValue;
            case '$lte':
                return fieldValue <= expectedValue;
            case '$in':
                return Array.isArray(expectedValue) && expectedValue.includes(fieldValue);
            case '$nin':
                return Array.isArray(expectedValue) && !expectedValue.includes(fieldValue);
            case '$contains':
                return typeof fieldValue === 'string' && fieldValue.includes(expectedValue);
            case '$startsWith':
                return typeof fieldValue === 'string' && fieldValue.startsWith(expectedValue);
            case '$endsWith':
                return typeof fieldValue === 'string' && fieldValue.endsWith(expectedValue);
            case '$regex':
                try {
                    let regex = new RegExp(expectedValue);
                    return typeof fieldValue === 'string' && regex.test(fieldValue);
                } catch {
                    return false;
                }
            case '$exists':
                return expectedValue ? fieldValue !== undefined : fieldValue === undefined;
            case '$type':
                return typeof fieldValue === expectedValue;
            case '$size':
                return Array.isArray(fieldValue) && fieldValue.length === expectedValue;
            default:
                console.warn(`Unknown operator: ${operator}`);
                return false;
        }
    }

    this.applySorting = function (objects, sortBy, descending = false) {
        // Support multiple sort fields
        if (typeof sortBy === 'string') {
            sortBy = [{ field: sortBy, descending: descending }];
        } else if (!Array.isArray(sortBy)) {
            sortBy = [sortBy];
        }

        return objects.sort((a, b) => {
            for (let sortSpec of sortBy) {
                let field = typeof sortSpec === 'string' ? sortSpec : sortSpec.field;
                let desc = typeof sortSpec === 'object' ? sortSpec.descending : descending;

                let aVal = this.getNestedProperty(a, field);
                let bVal = this.getNestedProperty(b, field);

                let result = this.compareForSort(aVal, bVal);

                if (result !== 0) {
                    return desc ? -result : result;
                }
            }
            return 0;
        });
    }

    this.compareForSort = function (aVal, bVal) {
        // Handle null/undefined values
        const aInvalid = aVal === undefined || aVal === null;
        const bInvalid = bVal === undefined || bVal === null;

        if (aInvalid && bInvalid) return 0;
        if (aInvalid) return 1;
        if (bInvalid) return -1;

        // Handle different types
        if (typeof aVal !== typeof bVal) {
            return typeof aVal > typeof bVal ? 1 : -1;
        }

        // String comparison
        if (typeof aVal === 'string' && typeof bVal === 'string') {
            return aVal.localeCompare(bVal);
        }

        // Numeric comparison
        if (typeof aVal === 'number' && typeof bVal === 'number') {
            return aVal - bVal;
        }

        // Date comparison
        if (aVal instanceof Date && bVal instanceof Date) {
            return aVal.getTime() - bVal.getTime();
        }

        // Boolean comparison
        if (typeof aVal === 'boolean' && typeof bVal === 'boolean') {
            return aVal === bVal ? 0 : (aVal ? 1 : -1);
        }

        // Array comparison (by length)
        if (Array.isArray(aVal) && Array.isArray(bVal)) {
            return aVal.length - bVal.length;
        }

        // Object comparison (by string representation)
        if (typeof aVal === 'object' && typeof bVal === 'object') {
            return JSON.stringify(aVal).localeCompare(JSON.stringify(bVal));
        }

        // Fallback comparison
        return String(aVal).localeCompare(String(bVal));
    }

    async function populateRelWithExistingObjects(joinName, leftType, rightType) {
        try {
            console.debug(`Rel ${joinName} created between ${leftType} and ${rightType}`);
        } catch (error) {
            console.error(`Error populating join ${joinName}:`, error);
        }
    }
}

module.exports = {
    getSimpleFSStorageStrategy: function () {
        return new SimpleFSStorageStrategy();
    }
}
