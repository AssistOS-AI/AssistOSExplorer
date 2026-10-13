const workspaceModule = assistOS.loadModule("workspace");
const documentModule = assistOS.loadModule("document");

function getContext(element) {
    const rawContext = element.getAttribute("data-context") || "{}";
    try {
        return JSON.parse(decodeURIComponent(rawContext));
    } catch {
        return {};
    }
}

export class AudioCreator {
    constructor(element, invalidate) {
        this.element = element;
        this.invalidate = invalidate;
        let documentPresenter = document.querySelector("document-view-page").webSkelPresenter;
        this._document = documentPresenter._document;
        let context = getContext(this.element);
        let chapterId = context.chapterId;
        this.chapterId = chapterId;
        let chapter = this._document.chapters.find(chapter => chapter.id === chapterId);
        this.chapter = chapter;
        this.paragraphId = context.paragraphId;
        let paragraphElement = documentPresenter.element.querySelector(`paragraph-item[data-paragraph-id="${this.paragraphId}"]`);
        this.paragraphPresenter = paragraphElement ? paragraphElement.webSkelPresenter : null;
        this.commandsEditor = this.paragraphPresenter ? this.paragraphPresenter.commandsEditor : null;
        this.paragraph = chapter.paragraphs.find(paragraph => paragraph.id === this.paragraphId);
        this.commands = this.paragraph.commands;
        let pluginIconContainer = this.paragraphPresenter ? this.paragraphPresenter.element.querySelector(".plugin-circle.audio-creator") : null;
        if (pluginIconContainer) {
            let pluginIcon = pluginIconContainer.querySelector("simple-state-icon");
            this.iconPresenter = pluginIcon ? pluginIcon.webSkelPresenter : null;
        } else {
            this.iconPresenter = null;
            console.warn("AudioCreator: plugin icon container not found.");
        }
        this.invalidate();
        this.element.classList.add("maintain-focus");
    }

    async beforeRender() {
        this.currentEffects = "";
        if(this.commands.effects){
            for(let effect of this.commands.effects){
                this.currentEffects += `<effect-item class="pointer" data-presenter="effect-item" data-id="${effect.id}"></effect-item>`;
            }
        }
    }
    async afterRender() {
        if(this.commands.audio){
            let audioElement = this.element.querySelector(".paragraph-audio");
            audioElement.classList.remove("hidden");
            this.element.querySelector(".delete-audio").classList.remove("hidden");
            this.element.querySelector(".volume-item").classList.remove("hidden");
            let volumeInput = this.element.querySelector("#volume");
            volumeInput.value = this.commands.audio.volume;
            let saveVolumeButton = this.element.querySelector(".save-volume");
            volumeInput.addEventListener("input", async () => {
                let volume = parseFloat(volumeInput.value);
                audioElement.volume = volume / 100;
                if(volume !== this.commands.audio.volume){
                    saveVolumeButton.classList.remove("hidden");
                } else {
                    saveVolumeButton.classList.add("hidden");
                }
            });
            audioElement.src = await workspaceModule.getAudioURL(this.commands.audio.id);
        }
        if(this.commands.speech){
            let deleteSpeechButton = this.element.querySelector(".delete-speech");
            deleteSpeechButton.classList.remove("hidden");
        }
        if(this.commands.silence){
            let currentSilenceElement = this.element.querySelector(".current-silence-time");
            currentSilenceElement.classList.remove("hidden");
            let silenceTime = this.element.querySelector(".silence-time");
            silenceTime.innerHTML = this.commands.silence.duration;
        }
        if(this.paragraph.text.trim() === ""){
            let warnMessage = `No text to convert to speech`;
            this.showSpeechWarning(warnMessage);
        }
    }
    async saveVolume(button){
        let volumeInput = this.element.querySelector("#volume");
        this.commands.audio.volume = parseFloat(volumeInput.value);
        await this.commandsEditor.invalidateCompiledVideos();
        await documentModule.updateParagraphCommands(this.chapterId, this.paragraphId, this.commands);
        button.classList.add("hidden");
    }
    showSpeechWarning(message){
        let warning = `
                <div class="paragraph-warning">
                    <img loading="lazy" src="/explorer/assets/icons/warning.svg" class="video-warning-icon" alt="warn">
                    <div class="warning-text">${message}</div>
                </div>`;
        let ttsSection = this.element.querySelector(".tts-section");
        ttsSection.insertAdjacentHTML("beforeend", warning);
    }
    async insertSpeech() {
        if (!this.ensureContext()) {
            assistOS.showToast("Paragraph context missing, please reopen the plugin.", "error");
            return;
        }
        await this.commandsEditor.insertCommandWithTask("speech", {});
        this.invalidate();
    }
    async insertAudio(){
        if (!this.ensureContext()) {
            assistOS.showToast("Paragraph context missing, please reopen the plugin.", "error");
            return;
        }
        let audioId = await this.commandsEditor.insertAttachmentCommand("audio");
        if(audioId){
            await this.saveAudioAttachmentVariable(audioId);
            this.changeIconState("on");
            if (this.iconPresenter && typeof this.iconPresenter.highlightIcon === "function") {
                this.iconPresenter.highlightIcon();
            }
            this.invalidate();
        }
    }
    async deleteAudio(){
        if (!this.ensureContext()) {
            assistOS.showToast("Paragraph context missing, please reopen the plugin.", "error");
            return;
        }
        await this.commandsEditor.deleteCommand("audio");
        this.changeIconState("off");
        if (this.iconPresenter && typeof this.iconPresenter.removeHighlight === "function") {
            this.iconPresenter.removeHighlight();
        }
        this.invalidate();
    }
    async deleteSpeech(){
        if (!this.ensureContext()) {
            assistOS.showToast("Paragraph context missing, please reopen the plugin.", "error");
            return;
        }
        await this.commandsEditor.deleteCommand("speech");
        this.invalidate();
    }
    async deleteSilence(){
        if (!this.ensureContext()) {
            assistOS.showToast("Paragraph context missing, please reopen the plugin.", "error");
            return;
        }
        await this.commandsEditor.deleteCommand("silence");
        this.invalidate();
    }
    async insertSoundEffect(){
        if (!this.ensureContext()) {
            assistOS.showToast("Paragraph context missing, please reopen the plugin.", "error");
            return;
        }
        await this.commandsEditor.insertAttachmentCommand("effects");
        this.invalidate();
    }
    async deleteEffect(button, id){
        if (!this.ensureContext()) {
            assistOS.showToast("Paragraph context missing, please reopen the plugin.", "error");
            return;
        }
        await this.commandsEditor.deleteCommand("effects", id);
        this.invalidate();
    }
    async insertSilence(targetElement) {
        if (!this.ensureContext()) {
            assistOS.showToast("Paragraph context missing, please reopen the plugin.", "error");
            return;
        }
        let silenceInput = this.element.querySelector("#silence");
        let data = {
            duration: parseInt(silenceInput.value)
        }
        await this.commandsEditor.insertSimpleCommand("silence", data);
        this.invalidate();
    }
    async saveAudioAttachmentVariable(audioId) {
        try {
            const audioUrl = await workspaceModule.getAudioURL(audioId);
            if (!audioUrl) {
                return;
            }
            await documentModule.setVarValue(this._document.id, "audio-attachment", audioUrl);
        } catch (error) {
            console.error("Failed to persist audio attachment variable", error);
        }
    }
    changeIconState(state){
        if (!this.ensureContext()) {
            return;
        }
        let pluginIcon = this.paragraphPresenter.element.querySelector(".plugin-circle.audio-creator");
        if(!pluginIcon){
            return;
        }
        if(state === "on"){
            pluginIcon.classList.add("highlight-attachment");
        }else {
            pluginIcon.classList.remove("highlight-attachment");
        }
    }
    ensureContext(){
        if (this.paragraphPresenter && this.commandsEditor) {
            return true;
        }
        const documentViewPage = document.querySelector("document-view-page");
        if (!documentViewPage || !documentViewPage.webSkelPresenter) {
            return false;
        }
        const documentPresenter = documentViewPage.webSkelPresenter;
        if (!documentPresenter) {
            return false;
        }
        const paragraphElement = documentPresenter.element.querySelector(`paragraph-item[data-paragraph-id="${this.paragraphId}"]`);
        if (!paragraphElement) {
            return false;
        }
        this.paragraphPresenter = paragraphElement.webSkelPresenter;
        this.commandsEditor = this.paragraphPresenter ? this.paragraphPresenter.commandsEditor : null;
        return Boolean(this.paragraphPresenter && this.commandsEditor);
    }
}
