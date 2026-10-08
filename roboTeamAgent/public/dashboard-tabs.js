export function initDashboardTabs({ root = document, onChange = () => {}, initialTabId } = {}) {
    const tablist = root.querySelector('[data-dashboard-tabs]');
    if (!tablist) return { destroy() {} };
    const tabs = Array.from(tablist.querySelectorAll('[role="tab"]'));
    const panels = tabs.map(tab => root.getElementById(tab.getAttribute('aria-controls')));

    const select = (selected, focus = false) => {
        tabs.forEach((tab, index) => {
            const active = index === selected;
            tab.setAttribute('aria-selected', String(active));
            tab.tabIndex = active ? 0 : -1;
            panels[index].hidden = !active;
        });
        if (focus) tabs[selected].focus();
        onChange();
    };

    const listeners = tabs.map((tab, index) => {
        const click = () => select(index);
        const keydown = event => {
            let selected;
            switch (event.key) {
                case 'ArrowRight': selected = (index + 1) % tabs.length; break;
                case 'ArrowLeft': selected = (index + tabs.length - 1) % tabs.length; break;
                case 'Home': selected = 0; break;
                case 'End': selected = tabs.length - 1; break;
                default: return;
            }
            event.preventDefault();
            select(selected, true);
        };
        tab.addEventListener('click', click);
        tab.addEventListener('keydown', keydown);
        return { tab, click, keydown };
    });
    const initial = tabs.findIndex(tab => tab.id === initialTabId);
    select(initial < 0 ? 0 : initial);

    return {
        destroy() {
            listeners.forEach(({ tab, click, keydown }) => {
                tab.removeEventListener('click', click);
                tab.removeEventListener('keydown', keydown);
            });
        },
    };
}
