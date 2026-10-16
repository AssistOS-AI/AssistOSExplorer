async function loadPartial(selector, path) {
    const target = document.querySelector(selector);
    if (!target) return;
    const response = await fetch(path);
    if (!response.ok) throw new Error(`Failed to load ${path}: ${response.status}`);
    target.innerHTML = await response.text();
}

function initializeMenus() {
    const menus = [...document.querySelectorAll('.menu')];

    function close(menu, returnFocus = false) {
        const trigger = menu.querySelector('.menu-trigger');
        menu.classList.remove('open');
        trigger.setAttribute('aria-expanded', 'false');
        if (returnFocus) trigger.focus();
    }

    for (const menu of menus) {
        const trigger = menu.querySelector('.menu-trigger');
        trigger.addEventListener('click', () => {
            const willOpen = !menu.classList.contains('open');
            for (const candidate of menus) close(candidate);
            if (willOpen) {
                menu.classList.add('open');
                trigger.setAttribute('aria-expanded', 'true');
            }
        });
        trigger.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') close(menu, true);
        });
        menu.querySelector('.submenu').addEventListener('keydown', (event) => {
            if (event.key === 'Escape') close(menu, true);
        });
    }

    document.addEventListener('click', (event) => {
        for (const menu of menus) {
            if (menu.classList.contains('open') && !menu.contains(event.target)) close(menu);
        }
    });
}

async function initializeDocumentation() {
    await Promise.all([
        loadPartial('[data-partial="header"]', 'partials/header.html'),
        loadPartial('[data-partial="footer"]', 'partials/footer.html'),
    ]);
    initializeMenus();
}

initializeDocumentation().catch((error) => console.error(error));
