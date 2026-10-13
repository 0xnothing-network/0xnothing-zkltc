export const THEME_STORAGE_KEY = "ox-theme";

/** Inline in <head> (app/layout.tsx) so a stored light theme applies before first paint. */
export const THEME_INIT_SCRIPT = `try{var t=localStorage.getItem("${THEME_STORAGE_KEY}");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}`;
