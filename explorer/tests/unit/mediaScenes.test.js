import test from 'node:test';
import assert from 'node:assert/strict';
import { getParagraphScenes, getSceneDuration, hasVisualScenes } from '../../shared/document/media-scenes.js';

test('zero audio spans visual scenes across paragraphs and chapters without lengthening the timeline', () => {
    const first = { mediaAttachments: { image: [{ id: 'one', duration: 2 }], audio: [{ id: 'music', duration: 0 }] } };
    const second = { mediaAttachments: { image: [{ id: 'two', duration: 5 }] } };
    const document = { chapters: [{ paragraphs: [first] }, { paragraphs: [second] }] };
    assert.equal(hasVisualScenes(document), true);
    const scenes = document.chapters.flatMap(chapter => chapter.paragraphs.flatMap((paragraph, index) => getParagraphScenes(chapter, paragraph, index, hasVisualScenes(document))));
    assert.equal(scenes[0].backgroundAudio.id, 'music');
    assert.equal(scenes[0].audio, undefined);
    assert.equal(scenes.reduce((total, scene) => total + getSceneDuration(scene), 0), 7);
    assert.equal(first.mediaAttachments.audio[0].duration, 0);
});

test('positive-duration narration remains attached to its scene', () => {
    const paragraph = { mediaAttachments: { image: [{ id: 'one' }], audio: [{ id: 'speech', duration: 8 }] } };
    const [scene] = getParagraphScenes({}, paragraph, 0, true);
    assert.equal(scene.audio.id, 'speech');
    assert.equal(getSceneDuration(scene), 8);
});

test('audio-only documents retain media-ended playback and chapter images qualify as visuals', () => {
    const paragraph = { commands: { audio: { id: 'sound', duration: 0 } } };
    const document = { chapters: [{ paragraphs: [paragraph] }] };
    assert.equal(hasVisualScenes(document), false);
    assert.equal(getParagraphScenes(document.chapters[0], paragraph, 0, hasVisualScenes(document))[0].audio.id, 'sound');
    document.chapters[0].mediaAttachments = { image: [{ id: 'cover' }] };
    assert.equal(hasVisualScenes(document), true);
    assert.equal(getParagraphScenes(document.chapters[0], paragraph, 0, true)[0].backgroundAudio.id, 'sound');
});
