// js/firebase.js
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyC7CIJ7TwwP-MSWLqEXWUgUMpsu6QG9vpg",
  authDomain: "voyage-e1ada.firebaseapp.com",
  projectId: "voyage-e1ada",
  storageBucket: "voyage-e1ada.firebasestorage.app",
  messagingSenderId: "533786107578",
  appId: "1:533786107578:web:1c7cf33451e457d0926c83"
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);