async function loadPartials() {
    const targets = Array.from(document.querySelectorAll('[data-include]'));
    await Promise.all(targets.map(async (target) => {
        const response = await fetch(target.dataset.include);
        if (!response.ok) throw new Error(`Could not load ${target.dataset.include}`);
        target.innerHTML = await response.text();
    }));

    for (const menu of document.querySelectorAll('.menu')) {
        const trigger = menu.querySelector('.menu-trigger');
        trigger.addEventListener('click', () => {
            const opening = !menu.classList.contains('open');
            for (const other of document.querySelectorAll('.menu.open')) {
                other.classList.remove('open');
                other.querySelector('.menu-trigger')?.setAttribute('aria-expanded', 'false');
            }
            if (opening) {
                menu.classList.add('open');
                trigger.setAttribute('aria-expanded', 'true');
            }
        });
        trigger.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') {
                menu.classList.remove('open');
                trigger.setAttribute('aria-expanded', 'false');
                trigger.focus();
            }
        });
    }
    document.addEventListener('click', (event) => {
        for (const menu of document.querySelectorAll('.menu.open')) {
            if (!menu.contains(event.target)) {
                menu.classList.remove('open');
                menu.querySelector('.menu-trigger')?.setAttribute('aria-expanded', 'false');
            }
        }
    });
}

loadPartials().catch((error) => {
    document.body.dataset.partialError = error.message;
});
