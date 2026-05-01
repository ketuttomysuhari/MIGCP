// GANTI dengan konfigurasi Firebase Realtime Database milik Anda.
// Firebase Console > Project Settings > General > Your apps > Web app config.
const firebaseConfig = {
  apiKey: "AIzaSyBzRPpiIHSMw_A9YR2JzSfU9J_0MbfU_EI",
  authDomain: "callskb.firebaseapp.com",
  databaseURL: "https://callskb.firebaseio.com",
  projectId: "callskb",
  storageBucket: "callskb.firebasestorage.app",
  messagingSenderId: "836684719733",
  appId: "1:836684719733:web:e1659464723a118d403a3c"
};

firebase.initializeApp(firebaseConfig);

const db = firebase.database();

const storage = firebase.storage();
