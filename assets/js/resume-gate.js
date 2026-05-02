// resume-gate.js — Google Sign-In gate before resume PDF download.
// Lazy-loaded by main.js on first click of [data-resume-trigger].

const STORAGE_KEY = "resumeGatePassed_v2";
const BYPASS_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export function initResumeGate(profile) {
    const dialog = document.querySelector("[data-resume-modal]");
    const errorEl = dialog?.querySelector("[data-resume-error]");
    const loadingRow = dialog?.querySelector("[data-resume-loading-row]");
    const loadingLabel = dialog?.querySelector("[data-resume-loading-label]");
    const cancelBtn = dialog?.querySelector("[data-resume-cancel]");
    const btnHost = dialog?.querySelector("[data-gsi-button]");

    if (!dialog || !btnHost) {
        console.warn("[resume-gate] modal markup missing");
        return { open() {}, destroy() {} };
    }

    const resumeUrl = profile?.links?.resume || "assets/img/resume.pdf";
    const apiUrl = profile?.links?.resumeApi || "";
    const clientId = profile?.links?.googleClientId || "";

    let gisInitialized = false;

    function showError(msg) {
        if (!errorEl) return;
        errorEl.textContent = msg;
        errorEl.hidden = !msg;
    }

    function setLoading(on, label) {
        if (!loadingRow) return;
        loadingRow.hidden = !on;
        if (on && loadingLabel && label) loadingLabel.textContent = label;
    }

    function triggerDownload() {
        const a = document.createElement("a");
        a.href = resumeUrl;
        a.download = "Gaurav-Lahoti-Resume.pdf";
        a.rel = "noopener";
        document.body.appendChild(a);
        a.click();
        a.remove();
    }

    function rememberPass() {
        try { localStorage.setItem(STORAGE_KEY, String(Date.now())); } catch (_) {}
    }

    function hasValidPass() {
        try {
            const t = Number(localStorage.getItem(STORAGE_KEY));
            return Number.isFinite(t) && (Date.now() - t) < BYPASS_MS;
        } catch (_) { return false; }
    }

    function close() {
        if (dialog.open) dialog.close();
    }

    async function onGoogleCredential(response) {
        const credential = response?.credential;
        if (!credential) {
            showError("Google sign-in didn't return a credential. Please try again.");
            return;
        }
        if (!apiUrl) {
            console.warn("[resume-gate] resumeApi not set — bypassing backend, downloading directly.");
            rememberPass();
            triggerDownload();
            setTimeout(close, 600);
            return;
        }

        showError("");
        setLoading(true, "Confirming it's you…");
        try {
            const res = await fetch(apiUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ credential }),
                credentials: "omit",
                mode: "cors"
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.ok) {
                throw new Error(data.error || `Request failed (${res.status})`);
            }
            rememberPass();
            setLoading(true, "Downloading…");
            triggerDownload();
            setTimeout(close, 600);
        } catch (err) {
            console.warn("[resume-gate] verify failed", err);
            showError("Couldn't verify your sign-in. Please try again.");
            setLoading(false);
        }
    }

    function waitForGis(timeoutMs = 5000) {
        return new Promise((resolve, reject) => {
            const start = Date.now();
            (function poll() {
                if (window.google?.accounts?.id) return resolve();
                if (Date.now() - start > timeoutMs) {
                    return reject(new Error("Google Identity script didn't load"));
                }
                setTimeout(poll, 80);
            })();
        });
    }

    async function ensureGisRendered() {
        if (gisInitialized) return;
        if (!clientId) {
            showError("Sign-in not configured.");
            return;
        }
        try {
            await waitForGis();
        } catch (err) {
            showError("Google sign-in failed to load. Check your connection and try again.");
            return;
        }
        const isNarrow = matchMedia("(max-width: 600px)").matches;
        window.google.accounts.id.initialize({
            client_id: clientId,
            callback: onGoogleCredential,
            ux_mode: "popup",
            auto_select: false,
            cancel_on_tap_outside: false
        });
        window.google.accounts.id.renderButton(btnHost, {
            theme: "filled_black",
            size: "large",
            text: "signin_with",
            shape: "pill",
            logo_alignment: "left",
            width: isNarrow ? 280 : 320
        });
        gisInitialized = true;
    }

    function open() {
        if (hasValidPass()) {
            triggerDownload();
            return;
        }
        showError("");
        setLoading(false);
        if (typeof dialog.showModal === "function") {
            if (!dialog.open) dialog.showModal();
        } else {
            dialog.setAttribute("open", "");
        }
        ensureGisRendered();
    }

    function onCancel() { close(); }

    function onBackdropClick(e) {
        const rect = dialog.getBoundingClientRect();
        const inside = e.clientX >= rect.left && e.clientX <= rect.right
                    && e.clientY >= rect.top && e.clientY <= rect.bottom;
        if (!inside) close();
    }

    cancelBtn?.addEventListener("click", onCancel);
    dialog.addEventListener("click", onBackdropClick);

    return {
        open,
        destroy() {
            cancelBtn?.removeEventListener("click", onCancel);
            dialog.removeEventListener("click", onBackdropClick);
        }
    };
}
