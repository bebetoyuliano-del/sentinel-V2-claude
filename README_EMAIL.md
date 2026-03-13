# Crypto Sentinel V2 - Email Module Documentation

Modul ini bertanggung jawab untuk mengirimkan data Decision Cards dalam format JSON murni ke penerima (Outlook/Power Automate).

## Fitur Utama
- **Power Automate Ready**: Subjek email menggunakan pola tetap yang mudah difilter oleh trigger "When a new email arrives (V3)".
- **Pure JSON Attachment**: Mengirimkan file `.json` dengan encoding UTF-8 dan `contentType: application/json`.
- **Reliability**: Dilengkapi dengan mekanisme retry ringan (1x) untuk kegagalan jaringan sementara.
- **Custom Headers**: Menyertakan header `X-Sentinel: DecisionCards` untuk filtering tingkat lanjut.

## Konfigurasi (.env)
Pastikan variabel berikut tersedia di file `.env` Anda:
- `SMTP_USER`: Email pengirim (Gmail).
- `SMTP_PASS`: App Password Gmail (16 digit).
- `EMAIL_TO`: Email tujuan.
- `EMAIL_SUBJECT_PREFIX`: "Crypto Sentinel - Decision Cards JSON".

## Cara Penggunaan (Kode)
```typescript
import { sendDecisionCardsEmail } from './mailer';

const cards = [/* array of objects */];
await sendDecisionCardsEmail(cards, { runId: 'optional-id' });
```

## Rencana Uji (Acceptance Criteria)
1. **Uji Manual**: Jalankan `Force Run` dari dashboard web dan pastikan email masuk ke inbox tujuan dengan subjek yang benar dan attachment yang bisa dibuka.
2. **Uji Validitas JSON**: Pastikan attachment `.json` dapat di-parse oleh tools online JSON validator atau `JSON.parse()` tanpa error.
3. **Uji Filter Power Automate**: Pastikan trigger Power Automate menyala saat email diterima.

## Operasional
Setelah melakukan perubahan kode atau update `.env`, jalankan:
```bash
git pull origin main
pm2 restart sentinel-v2
```
