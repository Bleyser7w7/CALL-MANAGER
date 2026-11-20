import { isSupabaseConfigured, requireSupabase } from "./supabase.js";

const form = document.querySelector("#login-form");
const recoveryForm = document.querySelector("#recovery-form");
const resetForm = document.querySelector("#reset-form");
const message = document.querySelector("#auth-message");
const setupNote = document.querySelector(".setup-note");
const forgotButton = document.querySelector("#forgot-password");
const backToLoginButton = document.querySelector("#back-to-login");
const passwordToggle = document.querySelector("#toggle-password");
const loginPassword = form?.querySelector('input[name="password"]');
let isPasswordRecovery = false;

passwordToggle?.addEventListener("click", () => {
  const isVisible = loginPassword?.type === "password";
  if (!loginPassword) return;
  loginPassword.type = isVisible ? "text" : "password";
  passwordToggle.setAttribute("aria-label", isVisible ? "Ocultar contraseña" : "Mostrar contraseña");
  passwordToggle.setAttribute("aria-pressed", String(isVisible));
});

function showMessage(text, kind = "") {
  if (!message) return;
  message.textContent = text;
  message.className = `notice ${kind}`;
}

if (form) {
  if (!isSupabaseConfigured) {
    showMessage("Falta configurar la URL y la clave pública de Supabase.", "error");
  } else {
    setupNote.hidden = true;
    const client = requireSupabase();
    const { data: { subscription } } = client.auth.onAuthStateChange((event, session) => {
      if (event === "PASSWORD_RECOVERY") {
        isPasswordRecovery = true;
        form.hidden = true;
        recoveryForm.hidden = true;
        resetForm.hidden = false;
        showMessage("Elige una nueva contraseña para tu cuenta.");
      } else if (session && !isPasswordRecovery) {
        window.location.replace("dashboard-supervisor.html");
      }
    });
    form.addEventListener("submit", async event => {
      event.preventDefault();
      const button = form.querySelector('button[type="submit"]');
      button.disabled = true;
      showMessage("Verificando acceso…");
      try {
        const values = new FormData(form);
      const { data, error } = await client.functions.invoke("login-username", {
        body: {
          username: String(values.get("username")).trim().toLowerCase(),
          password: String(values.get("password"))
        }
        });
        if (error) throw error;
      if (!data?.session?.access_token || !data?.session?.refresh_token) {
        throw new Error("No se pudo completar el inicio de sesión.");
      }
      const { error: sessionError } = await client.auth.setSession({
        access_token: data.session.access_token,
        refresh_token: data.session.refresh_token
      });
      if (sessionError) throw sessionError;
      } catch (error) {
      showMessage("Usuario o contraseña incorrectos, o no se pudo validar la cuenta.", "error");
      } finally {
        button.disabled = false;
      }
    });
    forgotButton?.addEventListener("click", async () => {
      form.hidden = true;
      recoveryForm.hidden = false;
      showMessage("Ingresa el correo asociado a tu cuenta para recuperar el acceso.");
    });
    backToLoginButton?.addEventListener("click", () => {
      recoveryForm.hidden = true;
      form.hidden = false;
      showMessage("");
    });
    recoveryForm?.addEventListener("submit", async event => {
      event.preventDefault();
      try {
        const email = String(new FormData(recoveryForm).get("email") || "").trim();
        const { error } = await client.auth.resetPasswordForEmail(email, {
          redirectTo: `${window.location.origin}${window.location.pathname.replace(/login\.html$/, "login.html")}`
        });
        if (error) throw error;
        showMessage("Si la cuenta existe, recibirás instrucciones para restablecer la contraseña.", "success");
      } catch (error) {
        showMessage(error.message || "No se pudo solicitar el restablecimiento.", "error");
      }
    });
    resetForm?.addEventListener("submit", async event => {
      event.preventDefault();
      const values = new FormData(resetForm);
      const password = String(values.get("password"));
      if (password !== String(values.get("confirm_password"))) {
        showMessage("Las contraseñas no coinciden.", "error");
        return;
      }
      const button = resetForm.querySelector('button[type="submit"]');
      button.disabled = true;
      try {
        const { error } = await client.auth.updateUser({ password });
        if (error) throw error;
        showMessage("Contraseña actualizada. Ya puedes iniciar sesión.", "success");
        await client.auth.signOut();
        isPasswordRecovery = false;
        resetForm.hidden = true;
        form.hidden = false;
      } catch (error) {
        showMessage(error.message || "No se pudo actualizar la contraseña.", "error");
      } finally {
        button.disabled = false;
      }
    });
    window.addEventListener("pagehide", () => subscription.unsubscribe(), { once: true });
  }
}
