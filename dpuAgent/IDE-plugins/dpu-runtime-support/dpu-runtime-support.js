export class DpuRuntimeSupport {
    constructor(element, invalidate) {
        this.element = element;
        this.invalidate = invalidate;
        // Request the first render; without it the component never renders and its render-complete promise never settles.
        this.invalidate();
    }

    beforeRender() {}
    afterRender() {}
}
