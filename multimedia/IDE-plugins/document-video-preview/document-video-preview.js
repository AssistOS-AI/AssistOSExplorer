import {executorTimer, videoUtils} from "/explorer/imports.js";
const documentModule = assistOS.loadModule("document");
const workspaceModule = assistOS.loadModule("workspace");
let blackScreen = new URL("../../assets/black-screen.png", import.meta.url).href;
const DEFAULT_IMAGE_SCENE_DURATION = 3;
export class DocumentVideoPreview {
    constructor(element, invalidate) {
        this.element = element;
        this.invalidate = invalidate;
        this.documentPresenter = this.element.closest("document-view-page").webSkelPresenter;
        this.document = this.documentPresenter._document;
        this.element.classList.add("minimized");
        this.pluginIcon = this.documentPresenter.element.querySelector(".plugin-circle.document-video-preview");
        this.invalidate(async () => {
            this.videoLength = await documentModule.estimateDocumentVideoLength?.(this.document.id);
            this.hasPlayableScenes = this.detectPlayableScenes();
        });
    }

    detectPlayableScenes() {
        if (!this.document?.chapters?.length) {
            return false;
        }
        for (const chapter of this.document.chapters) {
            for (const [paragraphIndex, paragraph] of (chapter?.paragraphs || []).entries()) {
                const scenes = this.getParagraphScenes(chapter, paragraph, paragraphIndex);
                if (scenes.some((scene) => this.hasSceneMedia(scene))) {
                    return true;
                }
            }
        }
        return false;
    }

    getChapterSceneAttachment(chapter, type, paragraphIndex) {
        const attachments = chapter?.mediaAttachments?.[type];
        if (!Array.isArray(attachments) || paragraphIndex < 0) {
            return null;
        }
        return attachments[paragraphIndex] ?? null;
    }

    getBaseSceneCommands(paragraph, chapter, paragraphIndex) {
        const commands = paragraph?.commands && typeof paragraph.commands === "object" && !Array.isArray(paragraph.commands)
            ? { ...paragraph.commands }
            : {};
        if (!commands.video) {
            const chapterVideo = this.getChapterSceneAttachment(chapter, "video", paragraphIndex);
            if (chapterVideo) {
                commands.video = chapterVideo;
            }
        }
        if (!commands.image) {
            const chapterImage = this.getChapterSceneAttachment(chapter, "image", paragraphIndex);
            if (chapterImage) {
                commands.image = chapterImage;
            }
        }
        return commands;
    }

    getParagraphScenes(chapter, paragraph, paragraphIndex) {
        const paragraphAudio = Array.isArray(paragraph?.mediaAttachments?.audio) ? paragraph.mediaAttachments.audio : [];
        const paragraphVideo = Array.isArray(paragraph?.mediaAttachments?.video) ? paragraph.mediaAttachments.video : [];
        const paragraphImage = Array.isArray(paragraph?.mediaAttachments?.image) ? paragraph.mediaAttachments.image : [];
        const baseCommands = this.getBaseSceneCommands(paragraph, chapter, paragraphIndex);
        const sceneCount = Math.max(paragraphAudio.length, paragraphVideo.length, paragraphImage.length);

        if (sceneCount > 0) {
            const scenes = [];
            for (let sceneIndex = 0; sceneIndex < sceneCount; sceneIndex += 1) {
                const scene = {};
                const audio = paragraphAudio[sceneIndex];
                const video = paragraphVideo[sceneIndex];
                const image = paragraphImage[sceneIndex];
                if (audio) {
                    scene.audio = audio;
                }
                if (video) {
                    scene.video = video;
                }
                if (image) {
                    scene.image = image;
                }
                if (!scene.video && sceneIndex === 0 && baseCommands.video) {
                    scene.video = baseCommands.video;
                }
                if (!scene.image && sceneIndex === 0 && baseCommands.image) {
                    scene.image = baseCommands.image;
                }
                if (this.hasSceneMedia(scene)) {
                    scenes.push(scene);
                }
            }
            if (scenes.length > 0) {
                return scenes;
            }
        }

        return this.hasSceneMedia(baseCommands) ? [baseCommands] : [];
    }

    getParagraphSceneCount(chapter, paragraph, paragraphIndex) {
        return this.getParagraphScenes(chapter, paragraph, paragraphIndex).length;
    }

    getSceneCommands(chapter, paragraph, paragraphIndex, sceneIndex = 0) {
        const scenes = this.getParagraphScenes(chapter, paragraph, paragraphIndex);
        if (!scenes.length) {
            return {};
        }
        return scenes[Math.max(0, Math.min(sceneIndex, scenes.length - 1))] || {};
    }

    hasSceneMedia(commands = {}) {
        return Boolean(commands.video || commands.audio || commands.image || commands.silence);
    }

    getSceneDuration(commands = {}) {
        if (commands.video) {
            const videoDuration = Number(commands.video.end) - Number(commands.video.start);
            const audioDuration = Number(commands.audio?.duration) || 0;
            return Math.max(Number.isFinite(videoDuration) ? videoDuration : 0, audioDuration);
        }
        if (commands.audio) {
            return Number(commands.audio.duration) || 0;
        }
        if (commands.silence) {
            return Number(commands.silence.duration) || 0;
        }
        if (commands.image) {
            const imageDuration = Number(commands.image.duration);
            return Number.isFinite(imageDuration) && imageDuration > 0
                ? imageDuration
                : DEFAULT_IMAGE_SCENE_DURATION;
        }
        return 0;
    }

    isValidDuration(value) {
        return Number.isFinite(value) && value >= 0;
    }

    renderEmptyState(message) {
        this.element.innerHTML = `
            <div class="video-preview-empty-state">
                <button type="button" class="video-preview-empty-close" data-local-action="closePlayer" aria-label="Close video preview">Close</button>
                <div class="video-preview-empty-title">Video preview unavailable</div>
                <div class="video-preview-empty-message">${message}</div>
            </div>
        `;
    }

    setEditingState(isEditable) {
        if (typeof this.documentPresenter?.toggleEditingState === "function") {
            this.documentPresenter.toggleEditingState(isEditable);
        }
    }

    beforeRender() {
        //open chapters if they are closed
        for (let chapter of this.document.chapters) {
            const chapterElement = this.documentPresenter.element.querySelector(`[data-chapter-id="${chapter.id}"]`);
            const chapterPresenter = chapterElement?.webSkelPresenter;
            if (chapterPresenter?.chapter?.visibility === "hide") {
                chapterPresenter.changeChapterVisibility("show");
            }
        }
        this.durationHTML = this.isValidDuration(this.videoLength)
            ? videoUtils.formatTime(this.videoLength)
            : videoUtils.formatTime(0);
        this.currentTime = 0;
    }

    showControls() {
        let controls = this.element.querySelector(".controls-mask");
        controls.style.display = "flex";
    }

    hideControls() {
        let controls = this.element.querySelector(".controls-mask");
        controls.style.display = "none";
    }

    afterRender() {
        if (!this.hasPlayableScenes) {
            this.renderEmptyState("This document does not contain any image, audio, video, or silence commands.");
            this.setEditingState(true);
            return;
        }

        let imageContainer = this.element.querySelector(".image-container");
        if (!this.boundShowControls) {
            this.boundShowControls = this.showControls.bind(this);
            this.boundHideControls = this.hideControls.bind(this);
            imageContainer.addEventListener("mouseover", this.boundShowControls);
            imageContainer.addEventListener("mouseout", this.boundHideControls);
        }

        this.audioPlayer = this.element.querySelector(".audio-player");
        this.imageTag = this.element.querySelector(".current-image");
        this.nextButton = this.element.querySelector(".next");
        this.previousButton = this.element.querySelector(".previous");
        this.currentChapterNumber = this.element.querySelector(".chapter-number");
        this.currentParagraphNumber = this.element.querySelector(".paragraph-number");
        this.currentTimeElement = this.element.querySelector(".current-time");
        this.videoPlayer = this.element.querySelector(".video-player");
        this.chapterAudioPlayer = this.element.querySelector(".chapter-background-sound");

        if(!this.boundPlayNextVideo){
            this.boundPlayNextVideo = this.incrementParagraphIndexAndPlayVideo.bind(this);
            this.videoPlayer.addEventListener("ended", this.boundPlayNextVideo);
        }
        if (!this.boundPlayNext) {
            this.boundPlayNext = this.incrementParagraphIndexAndPlay.bind(this);
            this.audioPlayer.addEventListener("ended", this.boundPlayNext);
        }

        if(!this.boundIncrementTimestampVideo){
            this.boundIncrementTimestampVideo = this.incrementTimestampVideo.bind(this);
            this.videoPlayer.addEventListener("timeupdate", this.boundIncrementTimestampVideo);
        }
        if (!this.boundIncrementTimestampAudio) {
            this.boundIncrementTimestampAudio = this.incrementTimestampAudio.bind(this);
            this.audioPlayer.addEventListener("timeupdate", this.boundIncrementTimestampAudio);
        }
        if (!this.boundIncrementTimestamp) {
            this.boundIncrementTimestamp = this.incrementTimestamp.bind(this);
        }
        this.attachLoadEventListeners();
        this.paragraphSceneIndex = 0;
        let currentParagraph = this.document.chapters[0].paragraphs[0];
        this.setPlayNextHandler(this.getSceneCommands(this.document.chapters[0], currentParagraph, 0, 0));
        this.setCurrentParagraphAndChapter(0, 0, 0);
        this.loadResource("image", blackScreen);
        this.setEditingState(false);

        this.chapterAudioLoaded = true;
        this.imageLoaded = true;
        this.audioLoaded = true;
        this.videoLoaded = true;
        let tasks = this.getParagraphsTasksNumber();
        if(tasks > 0){
            let info = `
                <div class="vide-preview-info">
                    <img loading="lazy" src="/explorer/assets/icons/info.svg" class="tasks-warning-icon" alt="info">
                    <div class="info-text">There are ${tasks} unfinished tasks.</div>
                </div>`;
            let closeSection = this.element.querySelector(".close-player");
            closeSection.insertAdjacentHTML('afterbegin', info);
        }
        this.playNext();
    }
    getParagraphsTasksNumber(){
        let tasks = 0;
        for (let chapter of this.document.chapters) {
            for (let paragraph of chapter.paragraphs) {
                if(paragraph.commands.speech){
                    if(paragraph.commands.speech.taskId){
                        tasks++;
                    }
                }
                if(paragraph.commands.lipsync){
                    if(paragraph.commands.lipsync.taskId){
                        tasks++;
                    }
                }
            }
        }
        return tasks;
    }
    attachLoadEventListeners() {
        if (!this.boundCheckImageLoaded) {
            this.boundCheckImageLoaded = this.checkResourceLoad.bind(this, "image");
            this.imageTag.addEventListener("load", this.boundCheckImageLoaded);
        }
        if (!this.boundCheckAudioLoaded) {
            this.boundCheckAudioLoaded = this.checkResourceLoad.bind(this, "audio");
            this.audioPlayer.addEventListener("canplay", this.boundCheckAudioLoaded);
        }
        if(!this.boundCheckChapterAudioLoaded){
            this.boundCheckChapterAudioLoaded = this.checkResourceLoad.bind(this, "chapterAudio");
            this.chapterAudioPlayer.addEventListener("canplay", this.boundCheckChapterAudioLoaded);
        }
        if(!this.boundCheckVideoLoaded){
            this.boundCheckVideoLoaded = this.checkResourceLoad.bind(this, "video");
            this.videoPlayer.addEventListener("canplay", this.boundCheckVideoLoaded);
        }
    }

    incrementTimestampAudio() {
        if(this.playNextHandler === this.audioPlayer){
            this.currentTimeElement.innerHTML = videoUtils.formatTime(this.currentTime + this.audioPlayer.currentTime);
        }
    }
    incrementTimestampVideo() {
        if(this.playNextHandler === this.videoPlayer){
            this.currentTimeElement.innerHTML = videoUtils.formatTime(this.currentTime + this.videoPlayer.currentTime);
            if(this.videoPlayer.currentTime >= this.videoPlayer.endTime){
                this.videoPlayer.pause();
                this.videoPlayer.currentTime = this.videoPlayer.endTime;
                const endedEvent = new Event('ended');
                this.videoPlayer.dispatchEvent(endedEvent);
            }
        }
    }

    afterUnload() {
        this.audioPlayer?.pause?.();
        this.audioPlayer?.removeEventListener?.("ended", this.boundPlayNext);
        this.audioPlayer?.removeEventListener?.("canplay", this.boundCheckAudioLoaded);
        this.imageTag?.removeEventListener?.("load", this.boundCheckImageLoaded);
        this.videoPlayer?.removeEventListener?.("ended", this.boundPlayNextVideo);
        this.videoPlayer?.removeEventListener?.("timeupdate", this.boundIncrementTimestampVideo);
        this.chapterAudioPlayer?.removeEventListener?.("canplay", this.boundCheckChapterAudioLoaded);
    }

    isPlaying (mediaElement) {
        return !mediaElement.paused && !mediaElement.ended && mediaElement.readyState > 2;
    }

    checkResourceLoad(resourceType) {
        switch (resourceType) {
            case "image":
                this.imageLoaded = true;
                break;
            case "audio":
                this.audioLoaded = true;
                break;
            case "chapterAudio":
                this.chapterAudioLoaded = true;
                break;
            case "video":
                this.videoLoaded = true;
                break;
        }
        this.playResource();
    }
    setPlayNextHandler(commands){
        let videoDuration = commands.video ? commands.video.end - commands.video.start : 0;
        let audioDuration = commands.audio ? commands.audio.duration : 0;
        if(videoDuration >= audioDuration){
            this.playNextHandler = this.videoPlayer;
        } else {
            this.playNextHandler = this.audioPlayer;
        }
    }
    playResource() {
        if (this.imageLoaded && this.audioLoaded && this.chapterAudioLoaded && this.videoLoaded && this.loaderTimeout) {
            this.hideLoader();

            let playPause = this.element.querySelector(".play-pause");
            let mode = playPause.getAttribute("data-mode");
            this.nextButton.classList.remove("disabled");
            let currentParagraph = this.document.chapters[this.chapterIndex].paragraphs[this.paragraphIndex];
            let currentChapter = this.document.chapters[this.chapterIndex];
            const sceneCommands = this.getSceneCommands(currentChapter, currentParagraph, this.paragraphIndex, this.paragraphSceneIndex);
            this.setPlayNextHandler(sceneCommands);

            if (!this.isPaused && mode !== "playFromBeginning") {
                if(sceneCommands.video){
                    this.videoPlayer.currentTime = sceneCommands.video.start;
                    this.videoPlayer.play();
                }
                if(sceneCommands.audio){
                    this.audioPlayer.play();
                }
                if(!this.isPlaying(this.chapterAudioPlayer) && currentChapter.backgroundSound){
                    this.chapterAudioPlayer.play();
                }
            }
        }
    }

    //call this when setting src
    loadResource(type, src, start, end, volume) {
        this.nextButton.classList.add("disabled");
        if (type === "image") {
            this.imageLoaded = false;
            this.imageTag.src = src;
        } else if(type === "audio") {
            this.audioLoaded = false;
            this.audioPlayer.src = src;
            this.audioPlayer.volume = volume / 100;
            this.audioPlayer.load();
        } else if(type === "video") {
            this.videoLoaded = false;
            this.videoPlayer.src = src;
            this.videoPlayer.volume = volume / 100;
            this.videoPlayer.startTime = parseFloat(start);
            this.videoPlayer.endTime = parseFloat(end);
            this.videoPlayer.load();
            this.videoPlayer.classList.remove("hidden");
        } else if(type === "chapterAudio") {
            this.chapterAudioLoaded = false;
            this.chapterAudioPlayer.src = src;
            this.chapterAudioPlayer.volume = volume / 100;
            this.chapterAudioPlayer.load();
        }
        this.showLoader();
    }
    showLoader() {
        if (this.loaderTimeout) {
            return;
        }
        this.loaderTimeout = setTimeout(() => {
            //dont show loader if silence
            if (this.silenceTimeout) {
                return;
            }

            let playPause = this.element.querySelector(".play-pause");
            playPause.removeAttribute("data-local-action");
            playPause.innerHTML = `<div class="loading-icon"><div>`;
        }, 500);
    }
    hideLoader(){
        clearTimeout(this.loaderTimeout);
        delete this.loaderTimeout;
        let playPause = this.element.querySelector(".play-pause");
        playPause.setAttribute("data-local-action", "playPause");
        let mode = playPause.getAttribute("data-mode");
        if (mode === "play") {
            playPause.innerHTML = `<img class="pointer" src="/explorer/assets/icons/pause.svg" alt="pause">`;
        } else if (mode === "pause" || mode === "playFromBeginning") {
            playPause.innerHTML = `<img class="pointer" src="/explorer/assets/icons/play.svg" alt="play">`;
        }
    }

    decrementParagraphIndex() {
        if (this.paragraphSceneIndex > 0) {
            this.paragraphSceneIndex -= 1;
            return;
        }
        this.paragraphIndex -= 1;
        if (this.paragraphIndex < 0) {
            this.chapterIndex -= 1;
            if(this.chapterIndex < 0){
                console.log("reached start of document");
                this.setCurrentParagraphAndChapter(0, 0, 0);
                return;
            }
            this.paragraphIndex = this.document.chapters[this.chapterIndex].paragraphs.length - 1;
        }
        const previousParagraph = this.document.chapters[this.chapterIndex]?.paragraphs?.[this.paragraphIndex];
        const sceneCount = this.getParagraphSceneCount(this.document.chapters[this.chapterIndex], previousParagraph, this.paragraphIndex);
        this.paragraphSceneIndex = Math.max(0, sceneCount - 1);
    }

    incrementParagraphIndex() {
        if(!this.document.chapters[this.chapterIndex]){
            return;
        }
        const currentChapter = this.document.chapters[this.chapterIndex];
        const currentParagraph = currentChapter?.paragraphs?.[this.paragraphIndex];
        const sceneCount = this.getParagraphSceneCount(currentChapter, currentParagraph, this.paragraphIndex);
        if (sceneCount > 0 && this.paragraphSceneIndex < sceneCount - 1) {
            this.paragraphSceneIndex += 1;
            return;
        }
        this.paragraphSceneIndex = 0;
        this.paragraphIndex += 1;
        if (this.paragraphIndex === this.document.chapters[this.chapterIndex].paragraphs.length) {
            this.chapterIndex += 1;
            this.paragraphIndex = 0;
        }
        if (this.chapterIndex === this.document.chapters.length) {
            console.log("reached end of document");
        }
    }

    incrementParagraphIndexAndPlay() {
        if(this.playNextHandler === this.audioPlayer){
            this.currentTime += this.audioPlayer.duration;
            this.incrementParagraphIndex();
            this.audioPlayer.src = "";
            this.playNext();
        }
    }
    incrementParagraphIndexAndPlayVideo() {
        if(this.playNextHandler === this.videoPlayer){
            this.currentTime += this.getVideoDuration();
            this.incrementParagraphIndex();
        }
        // this.videoPlayer.src = "";
        // this.videoPlayer.classList.add("hidden");
        //needs to respect order of operations
        if(this.playNextHandler === this.videoPlayer){
            this.playNext();
        }
    }

    closePlayer() {
        this.setEditingState(true);
        this.audioPlayer?.pause?.();
        this.videoPlayer?.pause?.();
        this.chapterAudioPlayer?.pause?.();
        this.cancelTimeouts();
        this.element.remove();
        this.pluginIcon?.classList?.remove("document-highlight-plugin");
    }

    async playPause(targetElement) {
        let mode = targetElement.getAttribute("data-mode");
        let imgTag;
        if (mode === "pause") {
            imgTag = `<img class="pointer" src="/explorer/assets/icons/pause.svg" alt="pause">`;
            mode = "play";
            this.setEditingState(false);
            await this.resumeVideo();
        } else if (mode === "play") {
            imgTag = `<img class="pointer" src="/explorer/assets/icons/play.svg" alt="play">`;
            this.pauseVideoPreview();
            mode = "pause";
            this.setEditingState(true);
        } else if (mode === "reload" || mode === "playFromBeginning") {
            imgTag = `<img class="pointer" src="/explorer/assets/icons/pause.svg" alt="pause">`;
            mode = "play";
            this.nextButton.classList.remove("disabled");
            this.previousButton.classList.remove("disabled");
            this.setCurrentParagraphAndChapter(0, 0, 0);

            this.chapterAudioLoaded = true;
            this.audioLoaded = true;
            this.imageLoaded = true;
            this.videoLoaded = true;
            this.currentTime = 0;
            this.currentTimeElement.innerHTML = videoUtils.formatTime(this.currentTime);
            this.playNext();
        }
        targetElement.innerHTML = imgTag;
        targetElement.setAttribute("data-mode", mode);
    }

    pauseVideoPreview() {
        this.audioPlayer.pause();
        this.videoPlayer.pause();
        this.chapterAudioPlayer.pause();
        this.isPaused = true;
        if (this.silenceTimeout) {
            clearInterval(this.incrementTimeInterval);
            clearTimeout(this.silenceTimeout);
            delete this.silenceTimeout;
            delete this.incrementTimeInterval;

            const endTime = Date.now();
            const elapsedTime = endTime - this.silenceStartTime;
            if (!this.remainingSilentDuration) {
                const totalSilentDuration = this.silenceDuration || 0;

                // Calculate the remaining silent duration
                this.remainingSilentDuration = Math.ceil((totalSilentDuration - elapsedTime) / 1000) * 1000;
            }
        }
        //safeguard, when you pause during silence
        if (!this.resumeCallback) {
            this.resumeCallback = () => {
                this.isPaused = false;
                this.playNext();
            };
        }
    }

    async resumeVideo() {
        this.isPaused = false;
        let currentChapter = this.document.chapters[this.chapterIndex];
        let playPromises = [];
        if(currentChapter.backgroundSound){
            playPromises.push(this.chapterAudioPlayer.play());
        }
        let currentParagraph = currentChapter.paragraphs[this.paragraphIndex];
        const sceneCommands = this.getSceneCommands(currentChapter, currentParagraph, this.paragraphIndex, this.paragraphSceneIndex);
        if(sceneCommands.audio){
            playPromises.push(this.audioPlayer.play());
        }
        if(sceneCommands.video){
            playPromises.push(this.videoPlayer.play());
        }
        await Promise.all(playPromises);

        if (this.remainingSilentDuration > 0) {
            // Resume the silence with the remaining duration
            this.silenceStartTime = Date.now();
            this.incrementTimeInterval = setInterval(this.boundIncrementTimestamp, 1000);
            this.silenceTimeout = setTimeout(async () => {
                clearInterval(this.incrementTimeInterval);
                delete this.incrementTimeInterval;
                delete this.silenceTimeout;
                this.incrementParagraphIndex();
                this.remainingSilentDuration = 0; // Reset after completion
                if (this.resumeCallback) {
                    this.resumeCallback();
                    delete this.resumeCallback;
                }
            }, this.remainingSilentDuration);
        }
    }
    async playChapterBackgroundSound(chapter) {
        if (chapter.backgroundSound) {
            if (this.currentChapterBackgroundSound !== chapter.backgroundSound.id) {
                this.chapterAudioPlayer.pause();
                const audioSrc = await workspaceModule.getAudioURL(chapter.backgroundSound.id);
                this.loadResource("chapterAudio", audioSrc, "", "", chapter.backgroundSound.volume);
                this.chapterAudioPlayer.loop = chapter.backgroundSound.loop;
                this.currentChapterBackgroundSound = chapter.backgroundSound.id;
            }
        } else {
            this.chapterAudioPlayer.pause();
            delete this.currentChapterBackgroundSound;
        }
    }
    async playNext() {
        for (let i = this.chapterIndex; i < this.document.chapters.length; i++) {
            let chapter = this.document.chapters[i];
            const paragraphStartIndex = i === this.chapterIndex ? this.paragraphIndex : 0;
            for (let j = paragraphStartIndex; j < chapter.paragraphs.length; j++) {
                let paragraph = chapter.paragraphs[j];
                const scenes = this.getParagraphScenes(chapter, paragraph, j);
                const sceneStartIndex = i === this.chapterIndex && j === this.paragraphIndex
                    ? this.paragraphSceneIndex
                    : 0;
                for (let sceneIndex = sceneStartIndex; sceneIndex < scenes.length; sceneIndex += 1) {
                    const sceneCommands = scenes[sceneIndex];
                    if (this.isPaused) {
                        await new Promise(resolve => {
                            this.resumeCallback = resolve;
                        });
                    }
                    await this.playChapterBackgroundSound(chapter);
                    this.setCurrentParagraphAndChapter(i, j, sceneIndex);
                    if(sceneCommands.video){
                        let videoCommand = sceneCommands.video;
                        let videoSrc = await workspaceModule.getVideoURL(videoCommand.id);
                        this.scrollDocument();
                        this.loadResource("video", videoSrc, videoCommand.start, videoCommand.end, videoCommand.volume);
                        if (sceneCommands.audio){
                            let audioCommand = sceneCommands.audio;
                            let audioSrc = await workspaceModule.getAudioURL(audioCommand.id);
                            this.loadResource("audio", audioSrc, "", "", audioCommand.volume);
                        }
                        return;
                    } else if (sceneCommands.audio) {
                        let imageSrc = blackScreen;
                        if(sceneCommands.image){
                            imageSrc = await workspaceModule.getImageURL(sceneCommands.image.id);
                        }
                        this.loadResource("image", imageSrc);
                        let audioSrc = await workspaceModule.getAudioURL(sceneCommands.audio.id);
                        this.loadResource("audio", audioSrc, "", "", sceneCommands.audio.volume);
                        this.scrollDocument();
                        return;
                    } else if (sceneCommands["silence"]){
                        if(sceneCommands.image){
                            let imageSrc = await workspaceModule.getImageURL(sceneCommands.image.id);
                            this.loadResource("image", imageSrc);
                        } else {
                            this.loadResource("image", blackScreen);
                        }
                        let duration = sceneCommands["silence"].duration;
                        this.executeSilenceCommand(duration);
                        return;
                    } else if(sceneCommands.image){
                        let imageSrc = await workspaceModule.getImageURL(sceneCommands.image.id);
                        this.loadResource("image", imageSrc);
                        this.scrollDocument();
                        this.executeSilenceCommand(this.getSceneDuration(sceneCommands));
                        return;
                    }
                }
            }
        }
        //reached end of document
        this.prepareVideoForReload();
    }

    setCurrentParagraphAndChapter(chapterIndex, paragraphIndex, sceneIndex = 0) {
        this.chapterIndex = chapterIndex;
        this.paragraphIndex = paragraphIndex;
        this.paragraphSceneIndex = sceneIndex;
        this.currentChapterNumber.innerHTML = chapterIndex + 1;
        this.currentParagraphNumber.innerHTML = paragraphIndex + 1;
        let currentParagraph = this.document.chapters[this.chapterIndex].paragraphs[this.paragraphIndex];
        if(currentParagraph.commands.effects){
            videoUtils.setupEffects(this.playNextHandler, currentParagraph.commands.effects, this);
        }
    }

    prepareVideoForReload() {
        let playButton = this.element.querySelector(".play-pause");
        playButton.setAttribute("data-mode", "reload");
        playButton.innerHTML = `<img class="pointer" src="/explorer/assets/icons/refresh.svg" alt="reload">`;
        this.isPaused = false;
        this.chapterAudioPlayer.pause();
        this.setEditingState(true);
        this.nextButton.classList.add("disabled");
        this.currentTime = this.isValidDuration(this.videoLength) ? this.videoLength : 0;
        //end of the player changes the time to 0
        setTimeout(() => {
            this.currentTimeElement.innerHTML = videoUtils.formatTime(this.currentTime);
        }, 100);
    }
    executeSilenceCommand(duration) {
        this.silenceDuration = duration * 1000;
        this.silenceStartTime = Date.now();
        if (!this.imageTag.src) {
            this.loadResource("image", blackScreen);
        }
        this.incrementTimeInterval = setInterval(this.boundIncrementTimestamp, 1000);

        this.silenceTimeout = setTimeout(async () => {
            clearInterval(this.incrementTimeInterval);
            delete this.incrementTimeInterval;
            this.remainingSilentDuration = 0;
            this.incrementParagraphIndex();
            delete this.silenceTimeout;
            await this.playNext();
        }, this.silenceDuration);
    }

    incrementTimestamp() {
        this.currentTime += 1;
        this.currentTimeElement.innerHTML = videoUtils.formatTime(this.currentTime);
    }

    async skipToNextScene(targetElement) {
        this.nextButton.classList.add("disabled");
        //skip is called at the beginning of the document
        if(this.chapterIndex === 0 && this.paragraphIndex === 0 && this.paragraphSceneIndex === 0){
            this.previousButton.classList.remove("disabled");
        }
        this.cancelTimeouts();
        let playPause = this.element.querySelector(".play-pause");
        let currentMode = playPause.getAttribute("data-mode");
        let paragraph = this.document.chapters[this.chapterIndex].paragraphs[this.paragraphIndex];
        let sceneCommands = this.getSceneCommands(this.document.chapters[this.chapterIndex], paragraph, this.paragraphIndex, this.paragraphSceneIndex);
        if(currentMode === "playFromBeginning"){
            currentMode = "pause";
            playPause.setAttribute("data-mode", currentMode);
            this.pauseVideoPreview();
        }
        this.audioPlayer.pause();

        //clean up before moving on to the next scene
        this.playNextHandler.pause();
        if(sceneCommands.video){
            if(sceneCommands.audio){
                let maxDuration = Math.max(this.audioPlayer.duration, this.getVideoDuration());
                this.currentTime += maxDuration;
                this.audioPlayer.src = "";
            } else {
                this.currentTime += this.getVideoDuration();
            }
            this.currentTimeElement.innerHTML = videoUtils.formatTime(this.currentTime);
            this.videoPlayer.src = "";
            this.videoPlayer.classList.add("hidden");
        } else if (sceneCommands.audio) {
            this.currentTime = this.currentTime + this.audioPlayer.duration;
            this.currentTimeElement.innerHTML = videoUtils.formatTime(this.currentTime);
            this.audioPlayer.src = "";
        } else if (sceneCommands["silence"]) {
            this.currentTime += parseFloat(sceneCommands["silence"].duration);
            this.currentTimeElement.innerHTML = videoUtils.formatTime(this.currentTime);
        } else if(sceneCommands.image){
            this.currentTime += this.getSceneDuration(sceneCommands);
            this.currentTimeElement.innerHTML = videoUtils.formatTime(this.currentTime);
        }
        let chapter = this.document.chapters[this.chapterIndex];
        this.incrementChapterAudioTime(chapter, this.currentTime);
        this.incrementParagraphIndex();
        if (this.chapterIndex === this.document.chapters.length) {
            //reached end of document
            this.prepareVideoForReload();
            return;
        }

        let nextParagraph = this.document.chapters[this.chapterIndex].paragraphs[this.paragraphIndex];
        let nextSceneCommands = this.getSceneCommands(this.document.chapters[this.chapterIndex], nextParagraph, this.paragraphIndex, this.paragraphSceneIndex);
        if(!this.hasSceneMedia(nextSceneCommands)){
            return this.skipToNextScene();
        }
        this.setCurrentParagraphAndChapter(this.chapterIndex, this.paragraphIndex, this.paragraphSceneIndex);
        await this.playChapterBackgroundSound(this.document.chapters[this.chapterIndex]);
        if(nextSceneCommands.video){
            let hasAudio = false;
            if(nextSceneCommands.audio){
                this.audioPlayer.addEventListener("loadedmetadata", this.waitAudioLoad.bind(this), {once: true});
                let audioSrc = await workspaceModule.getAudioURL(nextSceneCommands.audio.id);
                this.loadResource("audio", audioSrc, "", "", nextSceneCommands.audio.volume);
                hasAudio = true;
            }
            this.videoPlayer.addEventListener("loadedmetadata", this.waitVideoLoad.bind(this, hasAudio), {once: true});
            if(currentMode === "play") {
                this.playNext();
                return;
            }
            let videoSrc = await workspaceModule.getVideoURL(nextSceneCommands.video.id);
            this.loadResource("video", videoSrc, nextSceneCommands.video.start, nextSceneCommands.video.end, nextSceneCommands.video.volume);
            this.scrollDocument();
            return;
        } else if(nextSceneCommands.audio){
            this.audioPlayer.addEventListener("loadedmetadata", this.waitResourceLoad.bind(this), {once: true});
            if(currentMode === "play") {
                this.playNext();
                return;
            }
            let audioSrc = await workspaceModule.getAudioURL(nextSceneCommands.audio.id);
            this.loadResource("audio", audioSrc, "", "", nextSceneCommands.audio.volume);
        } else if(nextSceneCommands["silence"]){
            this.remainingSilentDuration = parseFloat(nextSceneCommands["silence"].duration) * 1000;
            this.silenceDuration = this.remainingSilentDuration;
        }
        if(currentMode === "play") {
            this.nextButton.classList.remove("disabled");
            this.playNext();
            return;
        }
        if(nextSceneCommands.image){
            let imageSrc = await workspaceModule.getImageURL(nextSceneCommands.image.id);
            this.loadResource("image", imageSrc);
        } else {
            this.loadResource("image", blackScreen);
        }
        this.scrollDocument();
        this.nextButton.classList.remove("disabled");
    }
    waitAudioLoad(event) {
        if(this.videoPlayer.readyState >= 1){
            this.nextButton.classList.remove("disabled");
        }
    }
    waitVideoLoad(hasAudio, event) {
        if(hasAudio){
            if(this.audioPlayer.readyState >= 1){
                this.nextButton.classList.remove("disabled");
            }
            // else audio metadata not loaded yet
        } else {
            this.nextButton.classList.remove("disabled");
        }
    }
    waitResourceLoad(event) {
        this.nextButton.classList.remove("disabled");
    }
    skipTimeVideo(hasAudio, event) {
        if(hasAudio){
            if(this.audioPlayer.readyState >= 1 && !this.timestampUpdated){
                this.timestampUpdated = true;
                this.nextButton.classList.remove("disabled");
                let maxDuration = Math.max(this.audioPlayer.duration, this.getVideoDuration());
                this.currentTime = this.currentTime - maxDuration;
                this.currentTimeElement.innerHTML = videoUtils.formatTime(this.currentTime);
                this.decrementChapterAudioTime(this.document.chapters[this.chapterIndex], maxDuration);
            }
            // else audio metadata not loaded yet
        } else {
            this.timestampUpdated = true;
            this.currentTime = this.currentTime - this.getVideoDuration();
            this.currentTimeElement.innerHTML = videoUtils.formatTime(this.currentTime);
            this.nextButton.classList.remove("disabled");
            this.decrementChapterAudioTime(this.document.chapters[this.chapterIndex], this.getVideoDuration());
        }
    }
    skipTimeAudioAndVideo(event) {
        if(this.videoPlayer.readyState >= 1 && !this.timestampUpdated){
            this.timestampUpdated = true;
            let maxDuration = Math.max(this.audioPlayer.duration, this.getVideoDuration());
            this.currentTime = this.currentTime - maxDuration;
            this.currentTimeElement.innerHTML = videoUtils.formatTime(this.currentTime);
            this.nextButton.classList.remove("disabled");
            this.decrementChapterAudioTime(this.document.chapters[this.chapterIndex], maxDuration);
        }
    }
    skipTimeAudioOnly(event) {
        this.currentTime = this.currentTime - this.audioPlayer.duration;
        this.currentTimeElement.innerHTML = videoUtils.formatTime(this.currentTime);
        this.nextButton.classList.remove("disabled");
        this.decrementChapterAudioTime(this.document.chapters[this.chapterIndex], this.audioPlayer.duration);
    }
    cancelTimeouts() {
        //skip during loading of a scene
        if (this.loaderTimeout) {
            clearTimeout(this.loaderTimeout);
            delete this.loaderTimeout;
            this.imageLoaded = true;
            this.audioLoaded = true;
            this.chapterAudioLoaded = true;
            this.videoLoaded = true;
        }
        //skip during pause
        if (this.silenceTimeout) {
            clearTimeout(this.silenceTimeout);
            delete this.silenceTimeout;
            this.remainingSilentDuration = 0;
        }

        //stop incrementing timestamp
        if (this.incrementTimeInterval) {
            clearInterval(this.incrementTimeInterval);
            delete this.incrementTimeInterval;
        }
    }
    incrementChapterAudioTime(chapter, elapsedTime){
        if(chapter.backgroundSound){
            if(elapsedTime > this.chapterAudioPlayer.duration && this.chapterAudioPlayer.loop){
                this.chapterAudioPlayer.currentTime = elapsedTime - this.chapterAudioPlayer.duration;
            } else {
                this.chapterAudioPlayer.currentTime = elapsedTime;
            }
        }
    }
    decrementChapterAudioTime(chapter, elapsedTime){
        if(chapter.backgroundSound){
            if(this.chapterAudioPlayer.currentTime < elapsedTime && this.chapterAudioPlayer.loop){
                this.chapterAudioPlayer.currentTime = this.chapterAudioPlayer.duration - elapsedTime;
            } else {
                this.chapterAudioPlayer.currentTime -= elapsedTime;
            }
        }
    }
    async skipToPreviousScene(targetElement) {
        this.previousButton.classList.add("disabled");
        this.cancelTimeouts();
        let playPause = this.element.querySelector(".play-pause");
        let currentMode = playPause.getAttribute("data-mode");
        let paragraph;
        this.playNextHandler.pause();

        //skip previous is called at the end of the document
        if (currentMode === "reload") {
            playPause.setAttribute("data-mode", "pause");
            playPause.innerHTML = `<img class="pointer" src="/explorer/assets/icons/play.svg" alt="play">`;
            currentMode = "pause";
            this.isPaused = true;
            let lastParagraphIndex = this.document.chapters[this.document.chapters.length - 1].paragraphs.length - 1;
            const lastChapterIndex = this.document.chapters.length - 1;
            const lastChapter = this.document.chapters[lastChapterIndex];
            const lastParagraph = lastChapter.paragraphs[lastParagraphIndex];
            const lastSceneIndex = Math.max(0, this.getParagraphSceneCount(lastChapter, lastParagraph, lastParagraphIndex) - 1);
            this.setCurrentParagraphAndChapter(lastChapterIndex, lastParagraphIndex, lastSceneIndex);

            paragraph = this.document.chapters[this.chapterIndex].paragraphs[this.paragraphIndex];
            this.currentTime -= this.getSceneDuration(this.getSceneCommands(this.document.chapters[this.chapterIndex], paragraph, this.paragraphIndex, this.paragraphSceneIndex));
        } else {
            paragraph = this.document.chapters[this.chapterIndex].paragraphs[this.paragraphIndex];
        }
        let sceneCommands = this.getSceneCommands(this.document.chapters[this.chapterIndex], paragraph, this.paragraphIndex, this.paragraphSceneIndex);


        if (currentMode === "play"){
            await this.playPause(playPause);
        }
        //clean up before moving on to the previous scene
        this.imageTag.src = blackScreen;
        let elapsedTime = 0;
        if(sceneCommands.video){
            elapsedTime = this.videoPlayer.currentTime;
            this.currentTimeElement.innerHTML = videoUtils.formatTime(this.currentTime);
            this.videoPlayer.src = "";
            if(sceneCommands.audio){
                this.audioPlayer.src = "";
            }
        }else if (sceneCommands.audio) {
            elapsedTime = this.audioPlayer.currentTime;
            this.currentTimeElement.innerHTML = videoUtils.formatTime(this.currentTime);
            this.audioPlayer.src = "";
        } else if (sceneCommands["silence"]) {
            elapsedTime = Math.floor((this.silenceDuration - this.remainingSilentDuration) / 1000);
            this.currentTime -= elapsedTime;
            this.currentTimeElement.innerHTML = videoUtils.formatTime(this.currentTime);
        } else if(sceneCommands.image){
            elapsedTime = this.getSceneDuration(sceneCommands);
            this.currentTime -= elapsedTime;
            this.currentTimeElement.innerHTML = videoUtils.formatTime(this.currentTime);
        }
        let chapter = this.document.chapters[this.chapterIndex];
        this.decrementChapterAudioTime(chapter, elapsedTime);

        this.decrementParagraphIndex();
        await this.playChapterBackgroundSound(this.document.chapters[this.chapterIndex]);
        let previousParagraph = this.document.chapters[this.chapterIndex].paragraphs[this.paragraphIndex];
        let previousSceneCommands = this.getSceneCommands(this.document.chapters[this.chapterIndex], previousParagraph, this.paragraphIndex, this.paragraphSceneIndex);
        if (this.chapterIndex === 0 && this.paragraphIndex === 0 && this.paragraphSceneIndex === 0) {
            //reached start of document
            this.loadResource("image", blackScreen);
            this.setCurrentParagraphAndChapter(0, 0, 0);
            this.audioPlayer.currentTime = 0;
            this.chapterAudioPlayer.currentTime = 0;
            this.audioPlayer.src = "";
            this.previousButton.classList.add("disabled");
            if(previousSceneCommands.video){
                let videoSrc = await workspaceModule.getVideoURL(previousSceneCommands.video.id);
                this.loadResource("video", videoSrc, previousSceneCommands.video.start, previousSceneCommands.video.end, previousSceneCommands.video.volume);
                this.videoPlayer.classList.remove("hidden");
            }
            if(previousSceneCommands.audio){
                let audioSrc = await workspaceModule.getAudioURL(previousSceneCommands.audio.id);
                this.loadResource("audio", audioSrc, "", "", previousSceneCommands.audio.volume);
            }
            this.resetTimestamp();
            //pause the video at the beginning
            playPause.setAttribute("data-mode", "play");
            await this.playPause(playPause);
            playPause.setAttribute("data-mode", "playFromBeginning");
            this.isPaused = false;
            return;
        }
        //empty paragraph
        if(!this.hasSceneMedia(previousSceneCommands)){
            return this.skipToPreviousScene();
        }
        this.setCurrentParagraphAndChapter(this.chapterIndex, this.paragraphIndex, this.paragraphSceneIndex);
        //load previous scene from beginning
        if(previousSceneCommands.video){
            let hasAudio = false;
            this.timestampUpdated = false;
            if(previousSceneCommands.audio){
                let audioSrc = await workspaceModule.getAudioURL(previousSceneCommands.audio.id);
                this.loadResource("audio", audioSrc, "", "", previousSceneCommands.audio.volume);
                this.videoPlayer.addEventListener("loadedmetadata", this.skipTimeAudioAndVideo.bind(this), {once: true});
                hasAudio = true;
            }
            this.videoPlayer.addEventListener("loadedmetadata", this.skipTimeVideo.bind(this, hasAudio), {once: true});
            let videoSrc = await workspaceModule.getVideoURL(previousSceneCommands.video.id);
            this.loadResource("video", videoSrc, previousSceneCommands.video.start, previousSceneCommands.video.end, previousSceneCommands.video.volume);

        } else if (previousSceneCommands.audio) {
            this.audioPlayer.addEventListener("loadedmetadata", this.skipTimeAudioOnly.bind(this), {once: true});
            let audioSrc = await workspaceModule.getAudioURL(previousSceneCommands.audio.id);
            this.loadResource("audio", audioSrc, "", "", previousSceneCommands.audio.volume);
            if(previousSceneCommands.image){
                let imageSrc = await workspaceModule.getImageURL(previousSceneCommands.image.id);
                this.loadResource("image", imageSrc);
            } else {
                this.loadResource("image", blackScreen);
            }
        } else if (previousSceneCommands["silence"]) {
            this.currentTime -= parseFloat(previousSceneCommands["silence"].duration);
            this.currentTimeElement.innerHTML = videoUtils.formatTime(this.currentTime);
            //to be able to resume the video with the remaining silent duration
            this.remainingSilentDuration = previousSceneCommands["silence"].duration * 1000;
            this.silenceDuration = this.remainingSilentDuration;
            this.resumeCallback = () => {
                this.isPaused = false;
                this.playNext();
            };

            if(previousSceneCommands.image){
                let imageSrc = await workspaceModule.getImageURL(previousSceneCommands.image.id);
                this.loadResource("image", imageSrc);
            } else {
                this.loadResource("image", blackScreen);
            }
        } else if(previousSceneCommands.image){
            this.currentTime -= this.getSceneDuration(previousSceneCommands);
            this.currentTimeElement.innerHTML = videoUtils.formatTime(this.currentTime);
            let imageSrc = await workspaceModule.getImageURL(previousSceneCommands.image.id);
            this.loadResource("image", imageSrc);
            this.remainingSilentDuration = this.getSceneDuration(previousSceneCommands) * 1000;
            this.resumeCallback = () => {
                this.isPaused = false;
                this.playNext();
            };
        }

        this.scrollDocument();
        this.previousButton.classList.remove("disabled");
    }

    resetTimestamp() {
        clearInterval(this.incrementTimeInterval);
        delete this.incrementTimeInterval;
        this.currentTimeElement.innerHTML = videoUtils.formatTime(0);
        this.currentTime = 0;
    }

    scrollDocument() {
        let chapter = this.document.chapters[this.chapterIndex];
        let paragraph = chapter.paragraphs[this.paragraphIndex];
        let currentParagraph = this.documentPresenter.element.querySelector(`[data-paragraph-id="${paragraph.id}"]`);
        if (!currentParagraph) {
            return;
        }
        if (this.paragraphIndex === chapter.paragraphs.length - 1) {
            return currentParagraph.scrollIntoView({behavior: "smooth", block: "nearest"});
        }
        currentParagraph.scrollIntoView({behavior: "smooth", block: "center"});
    }

    switchDisplayMode(targetElement) {
        let currentMode = targetElement.getAttribute("data-mode");
        if (currentMode === "minimized") {
            targetElement.setAttribute("data-mode", "fullscreen");
            this.element.classList.remove("minimized");
            this.element.classList.add("fullscreen");
            let controls = this.element.querySelector(".controls-mask");
            let timer = new executorTimer(() => {
                controls.style.display = "none";
                this.element.style.cursor = "none";
            }, 3000);
            timer.start();
            let boundHideControlsFullscreen = this.hideControlsFullscreen.bind(this, controls, timer);
            this.element.addEventListener("mousemove", boundHideControlsFullscreen);
            this.boundRemoveListeners = this.removeListeners.bind(this, timer, boundHideControlsFullscreen);
            targetElement.addEventListener("click", this.boundRemoveListeners);

        } else {
            targetElement.setAttribute("data-mode", "minimized");
            this.element.classList.add("minimized");
            this.element.classList.remove("fullscreen");
            targetElement.removeEventListener("click", this.boundRemoveListeners);
        }
    }

    hideControlsFullscreen(controls, timer, event) {
        this.element.style.cursor = "default";
        controls.style.display = "flex";
        timer.reset();
    }

    removeListeners(timer, boundHideControlsFullscreen, event) {
        timer.stop();
        this.element.removeEventListener("mousemove", boundHideControlsFullscreen);
    }
    getVideoDuration() {
        return this.videoPlayer.endTime - this.videoPlayer.startTime;
    }
}
