/**
 * Retrieves the contextual host element (chapter or paragraph) for a plugin.
 * @param {HTMLElement} element - The plugin's host element.
 * @returns {{document: object, chapter: object, paragraph: object|null}}
 */
export function getContextualElement(element) {
    const rawContext = element.getAttribute("data-context") || "{}";
    let context;
    try {
        context = JSON.parse(decodeURIComponent(rawContext));
    } catch (error) {
        console.error("Invalid plugin context", error);
        return { document: null, chapter: null, paragraph: null };
    }

    const { chapterId, paragraphId } = context;

    const docPage = element.closest("document-view-page") || document.querySelector("document-view-page");
    const documentPresenter = docPage?.webSkelPresenter;
    const doc = documentPresenter?._document;

    if (!doc || !Array.isArray(doc.chapters)) {
        throw new Error("Document context or chapters array is not available.");
    }

    const chapter = doc.chapters.find(ch => ch.id === chapterId);
    if (!chapter) {
        throw new Error(`Chapter ${chapterId} not found.`);
    }

    let paragraph = null;
    if (paragraphId) {
        if (Array.isArray(chapter.paragraphs)) {
            paragraph = chapter.paragraphs.find(p => p.id === paragraphId);
        }
        if (!paragraph) {
            throw new Error(`Paragraph ${paragraphId} not found in chapter ${chapterId}.`);
        }
    }

    return { document: doc, chapter, paragraph };
}
