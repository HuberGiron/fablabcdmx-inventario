import { auth, db } from "./firebase-app.js";
import { $, setupNav } from "./common.js";
import { createUserWithEmailAndPassword, signInWithEmailAndPassword } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import { doc, setDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

setupNav();

$("#loginForm")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("#loginEmail").value.trim();
  const password = $("#loginPassword").value;
  try {
    await signInWithEmailAndPassword(auth, email, password);
    window.location.href = "./";
  } catch (err) {
    alert(`No se pudo iniciar sesión: ${err.message}`);
  }
});

$("#registerForm")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const nombre = $("#regNombre").value.trim();
  const numeroCuenta = $("#regNumeroCuenta").value.trim();
  const correo = $("#regCorreo").value.trim();
  const password = $("#regPassword").value;
  try {
    const cred = await createUserWithEmailAndPassword(auth, correo, password);
    await setDoc(doc(db, "users", cred.user.uid), {
      uid: cred.user.uid,
      role: "alumno",
      numeroCuenta,
      nombre,
      correo,
      activo: true,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    alert("Registro exitoso.");
    window.location.href = "./";
  } catch (err) {
    alert(`No se pudo registrar: ${err.message}`);
  }
});
