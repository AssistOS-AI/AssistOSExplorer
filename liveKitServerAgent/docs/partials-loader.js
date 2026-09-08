function closeMenus(except) {
  document.querySelectorAll(".site-nav__group").forEach((group) => {
    if (group !== except) {
      group.querySelector(".site-nav__menu")?.setAttribute("hidden", "");
      group.querySelector(".site-nav__trigger")?.setAttribute("aria-expanded", "false");
    }
  });
}

function initializeMenus() {
  document.querySelectorAll(".site-nav__trigger").forEach((trigger) => {
    trigger.addEventListener("click", () => {
      const group = trigger.closest(".site-nav__group");
      const menu = group?.querySelector(".site-nav__menu");
      if (!group || !menu) return;
      const open = trigger.getAttribute("aria-expanded") === "true";
      closeMenus(open ? null : group);
      trigger.setAttribute("aria-expanded", String(!open));
      menu.toggleAttribute("hidden", open);
    });
    trigger.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        closeMenus(null);
        trigger.focus();
      }
    });
  });
  document.addEventListener("click", (event) => {
    if (!event.target.closest(".site-nav__group")) closeMenus(null);
  });
}

async function loadPartial(target, path) {
  const host = typeof target === "string" ? document.querySelector(target) : target;
  if (!host) return;
  try {
    const response = await fetch(path, { cache: "no-cache" });
    if (response.ok) host.innerHTML = await response.text();
  } catch (_) {
    // Keep the page usable if a documentation partial cannot be loaded.
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  const jobs = [];
  document.querySelectorAll("[data-include]").forEach((element) => {
    jobs.push(loadPartial(element, element.getAttribute("data-include")));
  });
  if (document.querySelector("#site-header")) jobs.push(loadPartial("#site-header", "partials/header.html"));
  if (document.querySelector("#site-footer")) jobs.push(loadPartial("#site-footer", "partials/footer.html"));
  await Promise.all(jobs);
  (await import('../../docs/documentation-breadcrumb.js')).initializeDocumentationBreadcrumb('LiveKit Server');
  initializeMenus();
});
