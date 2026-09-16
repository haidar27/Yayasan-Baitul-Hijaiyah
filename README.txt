ABSENSIPRO — FIREBASE BARU

1. Buka Firebase Console dan buat project BARU.
2. Register Web App dan copy Firebase Config ke index.html pada FIREBASE_CONFIG.
3. Authentication > Sign-in method > aktifkan Email/Password.
4. Authentication > Users > Add user:
   Email: admin@auth.absensipro.local
   Password: buat password Admin sendiri.
5. Firestore Database > Create database.
6. Publish isi firestore.rules dari folder ini.
7. Install Firebase CLI: npm install -g firebase-tools
8. Login: firebase login
9. Pada folder project ini jalankan: firebase use --add
   pilih project Firebase BARU kamu.
10. Install dependencies:
    cd functions
    npm install
11. Kembali ke root project lalu deploy functions:
    firebase deploy --only functions,firestore:rules
12. Upload index.html ke repository GitHub Pages (root), menggantikan index.html lama.

Catatan:
- Google Maps API Key pada index.html tetap harus diisi jika fitur peta geofence ingin aktif.
- Password user tidak disimpan di Firestore. Password dikelola oleh Firebase Authentication.
- Cloud Functions memakai region asia-southeast2 agar sesuai dengan client.
