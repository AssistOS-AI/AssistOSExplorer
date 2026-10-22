const DEFAULT_IMAGE_SCENE_DURATION = 3;

export function hasVisualScenes(document) {
    return (document?.chapters || []).some((chapter) =>
        ['image', 'video'].some((type) => chapter.mediaAttachments?.[type]?.length)
        || (chapter.paragraphs || []).some((paragraph) =>
            ['image', 'video'].some((type) => paragraph.mediaAttachments?.[type]?.length || paragraph.commands?.[type])));
}

function normalizeSceneAudio(scene, backgroundAudio) {
    if (backgroundAudio && scene.audio && scene.audio.duration !== undefined && Number(scene.audio.duration) === 0) {
        const { audio, ...visualScene } = scene;
        return { ...visualScene, backgroundAudio: audio };
    }
    return scene;
}

const getChapterSceneAttachment = (chapter, type, paragraphIndex) => {
    const attachments = chapter?.mediaAttachments?.[type];
    if (!Array.isArray(attachments) || paragraphIndex < 0) {
        return null;
    }
    return attachments[paragraphIndex] ?? null;
};

const getBaseSceneCommands = (chapter, paragraph, paragraphIndex) => {
    const commands = paragraph?.commands && typeof paragraph.commands === 'object' && !Array.isArray(paragraph.commands)
        ? { ...paragraph.commands }
        : {};
    if (!commands.video) {
        const chapterVideo = getChapterSceneAttachment(chapter, 'video', paragraphIndex);
        if (chapterVideo) {
            commands.video = chapterVideo;
        }
    }
    if (!commands.image) {
        const chapterImage = getChapterSceneAttachment(chapter, 'image', paragraphIndex);
        if (chapterImage) {
            commands.image = chapterImage;
        }
    }
    return commands;
};

export const getParagraphScenes = (chapter, paragraph, paragraphIndex, backgroundAudio = false) => {
    const paragraphAudio = Array.isArray(paragraph?.mediaAttachments?.audio) ? paragraph.mediaAttachments.audio : [];
    const paragraphVideo = Array.isArray(paragraph?.mediaAttachments?.video) ? paragraph.mediaAttachments.video : [];
    const paragraphImage = Array.isArray(paragraph?.mediaAttachments?.image) ? paragraph.mediaAttachments.image : [];
    const baseCommands = getBaseSceneCommands(chapter, paragraph, paragraphIndex);
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
            if (!scene.audio && sceneIndex === 0 && baseCommands.audio) {
                scene.audio = baseCommands.audio;
            }
            if (!scene.video && sceneIndex === 0 && baseCommands.video) {
                scene.video = baseCommands.video;
            }
            if (!scene.image && sceneIndex === 0 && baseCommands.image) {
                scene.image = baseCommands.image;
            }
            if (scene.video || scene.audio || scene.image || scene.silence) {
                scenes.push(normalizeSceneAudio(scene, backgroundAudio));
            }
        }
        if (scenes.length > 0) {
            return scenes;
        }
    }

    return baseCommands.video || baseCommands.audio || baseCommands.image || baseCommands.silence
        ? [normalizeSceneAudio(baseCommands, backgroundAudio)]
        : [];
};

export const getSceneDuration = (commands = {}) => {
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
};

