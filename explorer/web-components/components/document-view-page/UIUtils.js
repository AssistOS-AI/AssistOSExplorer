import {generateId} from "../../../imports.js";
const workspaceModule = assistOS.loadModule("workspace");
const documentModule = assistOS.loadModule("document");
function lockItem(itemClass, presenter) {
    let editableItem = presenter.element.querySelector(`.${itemClass}`);
    editableItem.classList.add("locked-item");
}

function unlockItem(itemClass, presenter) {
    let editableItem = presenter.element.querySelector(`.${itemClass}`);
    editableItem.classList.remove("locked-item");
}
async function setUserIcon(imageId, userEmail, selectId, itemClass, presenter){
    let userIconElement = presenter.element.querySelector(`.user-icon-container[data-id="${selectId}"]`);
    if(userIconElement){
        return;
    }
    let imageSrc;
    if (imageId) {
        imageSrc = await workspaceModule.getImageURL(imageId);
    } else {
        imageSrc = "./assets/images/defaultUserPhoto.png";
    }
    let userIcon = `<div class="user-icon-container"  data-id="${selectId}">
                              <div class="name-tooltip">${userEmail}</div>
                              <img loading="lazy" src="${imageSrc}" class="user-icon" alt="user-icon">
                          </div>
                        `;
    let documentItem = presenter.element.querySelector(`.${itemClass}-container`);
    documentItem.insertAdjacentHTML('beforeend', userIcon);
}
function removeUserIcon(selectId, presenter){
    let userIcon = presenter.element.querySelector(`.user-icon-container[data-id="${selectId}"]`);
    if(userIcon){
        userIcon.remove();
    }
}
async function deselectItem(itemId, presenter){
    if(presenter.selectionInterval){
        clearInterval(presenter.selectionInterval);
        delete presenter.selectionInterval;
    }
    await documentModule.deselectDocumentItem(presenter._document.id, itemId, presenter.selectId);
}
const MEDIA_COMMAND_KEYS = new Set(["audio", "video", "image", "effects", "backgroundsound", "backgroundvideo"]);

const isMediaCommandLine = (line = "") => {
    if (typeof line !== "string") {
        return false;
    }
    const normalized = line.trim().toLowerCase();
    return normalized.startsWith("@media");
};

async function selectItem(lockItem, itemId, itemClass, presenter){
    presenter.selectId = generateId(8);
    if(presenter.selectionInterval){
        clearInterval(presenter.selectionInterval);
        delete presenter.selectionInterval;
    }
    await documentModule.selectDocumentItem(presenter._document.id, itemId, {
        lockItem: lockItem,
        selectId: presenter.selectId,
        userImageId: assistOS.user.imageId,
        userEmail: assistOS.user.email
    });
    presenter.selectionInterval = setInterval(async () => {
        let itemText = presenter.element.querySelector(`.${itemClass}`);
        lockItem = !itemText.hasAttribute("readonly");
        await documentModule.selectDocumentItem(presenter._document.id, itemId, {
            lockItem: lockItem,
            selectId: presenter.selectId,
            userImageId: assistOS.user.imageId,
            userEmail: assistOS.user.email
        });
    }, 6000 * 10);
}
function changeCommentIndicator(element, commentMessages) {
    let previewIcons = element.querySelector(".preview-icons");
    if(commentMessages.length > 0) {
        let commentIndicator = previewIcons.querySelector(".comment-icon-container");
        if(commentIndicator) {
            return;
        }
        commentIndicator = `<div class="comment-icon-container pointer" data-local-action="showComments">
                                            <img class="comment-indicator" src="/explorer/assets/icons/comment-indicator.svg">
                                        </div>`;
        previewIcons.insertAdjacentHTML("afterbegin", commentIndicator);
    } else {
        let commentIndicator = previewIcons.querySelector(".comment-icon-container");
        if(commentIndicator){
            commentIndicator.remove();
        }
    }
}

const createInfoIconMarkup = (icon) => {
    const count = Number(icon.count);
    const hasCount = Number.isFinite(count) && count > 0;
    const counterMarkup = hasCount ? `<span class="info-counter">${count}</span>` : '';
    return `<div class="info-icon-container ${icon.className}" title="${icon.title}">
                <img class="info-icon" src="${icon.src}" alt="${icon.alt}">
                ${counterMarkup}
            </div>`;
};

function renderInfoIcons(element, info = {}) {
    const previewIcons = element.querySelector(".preview-icons");
    if (!previewIcons) {
        return;
    }

    previewIcons.querySelectorAll(".info-icon-container, .info-icon").forEach((node) => node.remove());

    const iconConfigs = [
        {
            className: "has-media",
            src: "/explorer/assets/icons/attachment.svg",
            alt: "media",
            title: "Media attachments",
            count: info.mediaCount
        },
        {
            className: "has-variables",
            src: "/explorer/assets/icons/variable.svg",
            alt: "variables",
            title: "Variables",
            count: info.variableCount
        },
        {
            className: "has-commands",
            src: "/explorer/assets/icons/variable.svg",
            alt: "commands",
            title: "Variables (commands)",
            count: info.commandCount
        }
    ].map((icon) => ({
        ...icon,
        count: Number(icon.count)
    })).filter((icon) => Number.isFinite(icon.count) && icon.count > 0);

    for (let i = iconConfigs.length - 1; i >= 0; i--) {
        previewIcons.insertAdjacentHTML("afterbegin", createInfoIconMarkup(iconConfigs[i]));
    }
}
function countCommandEntries(value) {
    if (!value) {
        return 0;
    }
    if (typeof value === "string") {
        return value
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line && !isMediaCommandLine(line))
            .length;
    }
    if (Array.isArray(value)) {
        return value.reduce((total, entry) => total + countCommandEntries(entry), 0);
    }
    if (typeof value === "object") {
        return Object.entries(value).reduce((total, [key, entry]) => {
            if (!entry) {
                return total;
            }
            const normalizedKey = typeof key === "string" ? key.toLowerCase() : "";
            if (MEDIA_COMMAND_KEYS.has(normalizedKey)) {
                return total;
            }
            if (typeof entry === "string" || Array.isArray(entry) || (typeof entry === "object" && entry !== null)) {
                return total + countCommandEntries(entry);
            }
            return total + 1;
        }, 0);
    }
    return 0;
}
function displayCurrentStatus(element, comments, level) {
    let previewIcons = element.querySelector(".preview-icons");
    if(comments.status === "error"){
        let errorStatus = "error";
        let plugin = assistOS.workspace.plugins[`${level}`].find(plugin => plugin.component === comments.plugin);
        previewIcons.insertAdjacentHTML("beforeend", `<img class="status-icon ${errorStatus} pointer" data-local-action="openPlugin ${level} ${comments.plugin} ${plugin.autoPin || false}" src="/explorer/assets/icons/${errorStatus}.svg">`);
    }
}
function changeStatusIcon(element, status, level, pluginName, autoPin = false) {
    let previewIcons = element.querySelector(".preview-icons");
    let statusIcon = previewIcons.querySelector(`.status-icon`);
    if(statusIcon){
        if(statusIcon.classList.contains(status)){
            return; // Status already set
        }
        statusIcon.remove();
    }
    if(status !== "ok"){
        previewIcons.insertAdjacentHTML("beforeend", `<img class="status-icon ${status} pointer" data-local-action="openPlugin ${level} ${pluginName} ${autoPin}" src="/explorer/assets/icons/${status}.svg">`);
    }
}
export default {
    lockItem,
    unlockItem,
    setUserIcon,
    removeUserIcon,
    deselectItem,
    selectItem,
    changeCommentIndicator,
    displayCurrentStatus,
    changeStatusIcon,
    renderInfoIcons,
    countCommandEntries
};
