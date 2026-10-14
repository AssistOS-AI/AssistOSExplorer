const documentModule = assistOS.loadModule("document");
import {formatTimeAgo} from "../../../../utils/utils.js";
export class DocumentSnapshotsModal{
    constructor(element, invalidate) {
        this.element = element;
        this.invalidate = invalidate;
        let documentsPage = document.querySelector("document-view-page");
        this.document = documentsPage.webSkelPresenter._document;
        this.invalidate();
    }
    async beforeRender() {
        this.snapshots = this.document.snapshots;
        if(this.document.type === documentModule.documentTypes.SNAPSHOT){
            let documentInfo = JSON.parse(assistOS.UI.unsanitize(this.document.abstract));
            this.snapshots = await documentModule.getDocumentSnapshots(documentInfo.originalDocumentId);
            this.originalDocumentId = documentInfo.originalDocumentId;
        } else {
            this.originalDocumentId = this.document.id;
        }
        let snapshotsHTML = "";
        let headerHTML = `<div class="no-snapshots">no snapshots created</div>`;
        this.snapshots.sort((a, b) => b.timestamp - a.timestamp);
        if(this.snapshots.length > 0){
            headerHTML = `<div class="list-header">
                                        <span class="snapshot-date">Time</span>
                                        <span class="snapshot-user">Created by</span>
                                        <span>Action</span>
                                    </div>`;
            for (let snapshot of this.snapshots) {
                snapshotsHTML += `<div class="document-snapshot" data-id="${snapshot.documentId}">
                                            <div class="snapshot-date">${formatTimeAgo(snapshot.timestamp)}</div>
                                          <div class="snapshot-user">${snapshot.email}</div>
                                            <div class="action-box-snapshots" data-local-action="showSnapshotsOptions ${snapshot.id} ${snapshot.documentId}">
                                                <img class="action-icon" loading="lazy" src="/explorer/assets/icons/action-dots.svg" alt="">
                                            </div>
                                     </div>`;
            }
        }
        this.snapshotsHTML=`${headerHTML}${snapshotsHTML}`;
    }
    afterRender() {
        if(this.document.type === documentModule.documentTypes.SNAPSHOT){
            let currentVersionButton = this.element.querySelector(".current-version");
            currentVersionButton.style.display = "block";
            let snapshotItem = this.element.querySelector(`.document-snapshot[data-id="${this.document.id}"]`);
            snapshotItem.classList.add("current-snapshot-version");
        }
    }
    closeModal() {
        assistOS.UI.closeModal(this.element);
    }
    async addSnapshot(){
        let snapshotData = {
            timestamp: Date.now(),
            email: assistOS.user.email
        }
        let snapshot = await documentModule.addDocumentSnapshot(this.originalDocumentId, snapshotData);
        this.snapshots.push(snapshot);
        this.invalidate();
    }
    async deleteSnapshot(targetElement, snapshotId){
        let message = "Are you sure you want to delete this snapshot?";
        let confirmation = await assistOS.UI.showModal("confirm-action-modal", {message}, true);
        if (!confirmation) {
            return;
        }
        await documentModule.deleteDocumentSnapshot(this.originalDocumentId, snapshotId);
        this.snapshots = this.snapshots.filter(snapshot => snapshot.id !== snapshotId);
        this.invalidate();
    }
    async openSnapshot(targetElement, documentId){
        this.closeModal();
        await assistOS.UI.changeToDynamicPage("document-view-page", `document-view-page/${documentId}`);
    }
    showSnapshotsOptions(targetElement, snapshotId, snapshotDocumentId) {
        let chapterOptions = `<action-box-snapshot data-id="${snapshotId}" data-document-id="${snapshotDocumentId}"></action-box-snapshot>`;
        targetElement.insertAdjacentHTML("afterbegin", chapterOptions);
        let controller = new AbortController();
        this.boundHideChapterOptions = this.hideSnapshotsOptions.bind(this, controller);
        document.addEventListener('click', this.boundHideChapterOptions, {signal: controller.signal});
    }
    hideSnapshotsOptions(controller, event) {
        controller.abort();
        let options = this.element.querySelector(`action-box-snapshot`);
        if (options) {
            options.remove();
        }
    }
    async showActionBox(_target, primaryKey, componentName, insertionMode) {
        this.actionBox = await assistOS.UI.showActionBox(_target, primaryKey, componentName, insertionMode);
    }
    async restoreSnapshot(targetElement, snapshotId, snapshotDocumentId){
        let snapshotData = {
            timestamp: Date.now(),
            email: assistOS.user.email
        }
        await documentModule.restoreDocumentSnapshot(this.originalDocumentId, snapshotId, snapshotData);
        await assistOS.UI.changeToDynamicPage("document-view-page", `document-view-page/${this.originalDocumentId}`);
        this.closeModal();
    }
}
