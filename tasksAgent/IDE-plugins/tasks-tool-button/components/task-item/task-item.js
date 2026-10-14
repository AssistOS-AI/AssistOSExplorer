const utilModule = assistOS.loadModule("util");
const documentModule = assistOS.loadModule("document");

export class TaskItem{
    constructor(element, invalidate){
        this.element = element;
        this.invalidate = invalidate;
        let id = this.element.getAttribute("data-id");
        let tasksModal = this.element.closest("document-tasks-modal");
        this.tasksModalPresenter = tasksModal.webSkelPresenter;
        this.task = this.tasksModalPresenter.getTask(id);

        this.invalidate(async ()=> {
            this.boundOnTasksUpdate = this.onTasksUpdate.bind(this);
            const subscribeToWorkspace = assistOS.NotificationRouter.subscribeToWorkspace?.bind(assistOS.NotificationRouter);
            const subscribeToSpace = assistOS.NotificationRouter.subscribeToSpace?.bind(assistOS.NotificationRouter);
            if (subscribeToWorkspace) {
                await subscribeToWorkspace(id, this.boundOnTasksUpdate);
            } else if (subscribeToSpace) {
                await subscribeToSpace(undefined, id, this.boundOnTasksUpdate);
            }
        })
    }
    onTasksUpdate(status){
        this.status = status;
        this.tasksModalPresenter.updateTaskInList(this.task.id, status);
        this.invalidate();
    }
    async beforeRender(){
        this.name = this.task.name;
        this.status = this.task.status;
        this.paragraphItem = document.querySelector(`paragraph-item[data-paragraph-id="${this.task.configs.paragraphId}"]`);
        const sourceCommand = (this.task.configs?.sourceCommand || this.task.name || "task").toString();
        this.taskAgent = sourceCommand.charAt(0).toUpperCase() + sourceCommand.slice(1);
        this.taskIconSrc = "/explorer/assets/icons/task.svg";
        if(!this.paragraphItem){
            this.paragraphText = "...........";
            return;
        }
        this.paragraphPresenter = this.paragraphItem.webSkelPresenter;
        this.paragraphText = this.paragraphPresenter.paragraph.text || "...........";
    }
    afterRender(){
        const taskStatus = this.element.querySelector(".task-item__status");
        if (taskStatus) {
            if (this.status === "failed") {
                taskStatus.setAttribute("data-local-action", "showTaskFailInfo");
            } else {
                taskStatus.removeAttribute("data-local-action");
            }
        }
        this.element.dataset.status = this.status || '';
        this.element.dataset.linkDisabled = this.paragraphItem ? 'false' : 'true';
    }

    scrollDocument(){
        let paragraphId = this.paragraphPresenter.paragraph.id;
        let paragraphIndex = this.paragraphPresenter.chapter.paragraphs.findIndex(paragraph => paragraph.id === paragraphId);
        if (paragraphIndex === this.paragraphPresenter.chapter.paragraphs.length - 1) {
            return this.paragraphItem.scrollIntoView({behavior: "smooth", block: "nearest"});
        }
        this.paragraphItem.scrollIntoView({behavior: "smooth", block: "center"});
    }
    async showTaskFailInfo(){
        let taskInfo = await utilModule.getTaskRelevantInfo(this.task.id);
        let info= "";
        if(typeof taskInfo === "object"){
            for(let [key,value] of Object.entries(taskInfo)){
                info += `${key}: ${value}\n`;
            }
        } else {
            info = taskInfo;
        }
        let taskInfoHTML = `<div class="task-item__info">${info}</div>`;
        let taskAction = this.element.querySelector(".task-item__status");
        taskAction.insertAdjacentHTML("beforeend", taskInfoHTML);
        document.addEventListener("click", this.removeInfoPopUp.bind(this), {once: true});
    }
    removeInfoPopUp(){
        let taskInfo = this.element.querySelector(".task-item__info");
        if (taskInfo) {
            taskInfo.remove();
        }
    }
    async deleteTask(){
        await utilModule.removeTask(this.task.id);
        if(this.task.configs.sourceCommand){
            delete this.paragraphPresenter.paragraph.commands[this.task.configs.sourceCommand].taskId;
            await documentModule.updateParagraphCommands(this.paragraphPresenter.chapter.id, this.paragraphPresenter.paragraph.id, this.paragraphPresenter.paragraph.commands);
        }
        this.element.remove();
    }
}
