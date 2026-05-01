# Realtime GCP/ICP Monitoring Web

Fitur:
- Semua pengguna yang membuka dan mengaktifkan monitoring tampil sebagai surveyor aktif.
- Marker surveyor hilang otomatis saat halaman ditutup atau koneksi putus.
- Upload KML, otomatis dikonversi ke GeoJSON.
- Titik GCP/ICP dapat ditandai selesai dan berubah warna hijau secara real-time.
- Semua perangkat melihat status titik dan posisi surveyor yang sama.
- Download hasil konversi GeoJSON.

## Cara pakai

1. Buat project Firebase.
2. Aktifkan Realtime Database.
3. Salin konfigurasi Firebase web app ke file `firebase-config.js`.
4. Untuk testing, gunakan rules berikut:

```json
{
  "rules": {
    ".read": true,
    ".write": true
  }
}
```

5. Jalankan dengan Live Server atau upload ke hosting HTTPS.

Catatan: GPS browser biasanya membutuhkan HTTPS, kecuali localhost.
