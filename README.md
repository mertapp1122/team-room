# Team Room

**İnsanlar ve yapay zekâ ajanları aynı kanallarda.** Slack benzeri, kendi bilgisayarında çalışan çok oyunculu bir çalışma alanı. Ekip arkadaşların ve Claude ajanların aynı odada konuşur. Bir ajanı `@` ile andığında, cevabını herkesin gördüğü bir thread'e yazar.

Ajanlar senin bilgisayarında, **kendi Claude aboneliğinle** (`claude -p`) çalışır. API anahtarı gerekmez.

*English: [README.en.md](README.en.md)*

![#sales kanalında Scout ajanının thread cevabı](docs/agent-thread.png)

## Neler var

- **Kanallar ve canlı sohbet:** iki tarayıcı penceresinde mesajlar anında görünür, thread'ler, okunmamış rozetleri
- **Çalışan ajanlar:** `@scout` gibi bir anma iş kuyruğuna düşer, bilgisayarındaki işçi `claude -p` ile koşar, cevap thread'e gelir. İşçi kapalıysa ajanlar "offline" görünür.
- **Ortak skill'ler:** `skills/` klasöründeki her skill'i bütün ajanlar yükler (örnek: teklif yazma, AI görünürlük kontrolü)
- **Bağlantılar:** salt okunur demo CRM (MCP aracı olarak). Connections sayfasından açılıp kapanır.
- **Kullanım ve maliyet:** her ajan koşusu kayıtlı (kim sordu, hangi kanal, model, süre, API karşılığı fiyat), kişi/kanal/ajan dökümü, ajan başına günlük sınır
- **#sales iş akışı:** haftalık taahhütler, 17:00 check-in otomasyonu ("şimdi çalıştır" düğmesi), pipeline panosu. Bir kartı sürüklediğinde herkesin ekranında yer değiştirir.
- **Herkes ajan kurar:** Yeni ajan formu (Haiku / Sonnet / Opus + üç parçalı kişilik), ajan profil sayfaları, Members sayfası

![Pipeline panosu](docs/pipeline-board.png)

## Gerekenler

| | |
|---|---|
| **Node.js 22.18 veya üstü** | 24 LTS öneririm. Kontrol: `node --version` |
| **Claude Code** | Kurulu ve giriş yapılmış olmalı. Terminalde `claude --version` çalışmalı. Ajanlar bu aboneliği kullanır. |
| **npm paketi** | Yok. `npm install` gerekmez, sıfır bağımlılık. |

macOS'ta geliştirildi ve test edildi. Windows'ta denemedim; orada WSL kullanmanı öneririm.

## Kurulum (2 dakika)

```bash
git clone https://github.com/mertapp1122/team-room.git
cd team-room
npm start
```

Git kullanmıyorsan: GitHub sayfasında **Code → Download ZIP**, zip'i aç, klasörde terminalden `npm start`.

Terminalde `Team Room running at http://localhost:5500` yazısını görünce tarayıcıda **iki pencere** aç:

- http://localhost:5500/?as=alex (sen, odanın sahibi)
- http://localhost:5500/?as=ayse (kurgusal ekip arkadaşı)

Birinde yazdığın mesaj ötekinde anında görünür. Ajanı denemek için `#general` kanalına şunu yaz:

```
@scout merhaba, ne işte iyisin?
```

Birkaç saniye içinde Scout'un cevabı thread'de belirir. Usage sayfasında bu koşunun süresi ve API karşılığı maliyeti görünür. Benim denememde bir Haiku cevabı yaklaşık 5 saniye sürdü, API karşılığı 0,002 $ civarındaydı. Ödemeyi aboneliğin üzerinden yaparsın, ayrı bir fatura çıkmaz.

## Kendine uyarla

Odadaki her şey demo: **Alex** senin yerini tutar. Ayşe, Deniz, Selin ve Burak kurgusal ekip arkadaşları; fotoğrafları yapay zekâyla üretilmiş portreler. CRM'deki şirketlerin hepsi uydurma.

**Kolay yol: Claude Code'a yaptır.** Bu klasörde Claude Code'u aç ve şunu kendi bilgilerinle doldurup yapıştır:

```
Team Room'u bizim odamız yap. Benim adım <ADIN>, şirketimiz <ŞİRKET: ne yapıyor, fiyatlar>.
src/seed.js içinde Alex yerine beni koy (id kısa ve küçük harf olsun), COMPANY bilgilerini
bizim işimize göre yaz, kanalları <KANALLAR> yap ve skills/agency-offer'ı bizim teklif yazma
şeklimize göre yeniden yaz. Eski adları geçen testleri güncelle, npm test'i koş, sonra npm run seed.
```

**Elle yapmak istersen:**

| Ne | Nerede |
|---|---|
| Şirket bilgileri (ajanların kesin kuralları) | `src/seed.js` → `COMPANY` |
| Kişiler ve ajanlar | `src/seed.js` → `MEMBERS` |
| Kanallar ve örnek mesajlar | `src/seed.js` → `CHANNELS`, `MESSAGES` |
| Ekibin ortak skill'leri | `skills/<ad>/SKILL.md` (Claude Code skill biçimi) |
| Senin fotoğrafın | `public/img/people/<senin-id>.jpg` (kare, 512×512 yeterli) |

Değişiklikten sonra `npm run seed` çalıştır. **Dikkat:** bu komut `data/` klasöründeki odayı sıfırlar, mesajlar silinir. Yeni ajanları ise kod yazmadan, uygulamanın içindeki **+ New agent** formuyla da ekleyebilirsin.

## Komutlar

| Komut | Ne yapar |
|---|---|
| `npm start` | Odayı ve ajan işçisini birlikte başlatır |
| `npm run server` | Yalnız oda (ajanlar offline kalır) |
| `npm run worker` | Yalnız ajan işçisi (oda açıkken) |
| `npm run seed` | Odayı demo verisine sıfırlar |
| `npm test` | 57 test, sahte ajanla (Claude'a gitmez, ücretsiz) |

Port doluysa: `PORT=5600 npm start`.

## Ajanlar nasıl çalışıyor

1. Biri bir ajanı `@` ile anar → oda bir iş açar.
2. Bilgisayarındaki işçi (`src/worker.js`) işi alır ve `claude -p` çalıştırır: ajanın modeli, kişiliği, sohbetin geçmişi, ekip skill'leri ve açık bağlantılar.
3. Ajan yalnız **Skill aracını** ve **salt okunur CRM araçlarını** kullanabilir. Web'e çıkamaz, dosya okuyamaz, kod çalıştıramaz, hiçbir şeyi değiştiremez (`--permission-mode dontAsk`).
4. İşçi `ANTHROPIC_API_KEY` değişkenini ortamdan siler. Böylece koşu her zaman giriş yaptığın Claude aboneliğinden gider.
5. Cevap thread'e yazılır, maliyet Usage sayfasına işlenir. Günlük sınırı aşan ajan durur ve herkes nedenini görür.

## Önemli: yalnız yerel

Oda yalnız `127.0.0.1` üzerinde dinler, bilerek. **Giriş sistemi yok:** `?as=` ile herkes herhangi biri olabilir. Ajanlar da senin bilgisayarında, senin aboneliğinle çalışıyor. Bu yüzden odayı internete açma. Aynı ağdaki ekip arkadaşlarınla denemek istersen `HOST=0.0.0.0 npm start` ile açabilirsin, ama bunu yalnız güvendiğin bir ağda yap.

## Sıfırdan kendin kur

Videodaki gibi Claude Code'la adım adım kendin kurmak istersen: [build-it-yourself/](build-it-yourself/) klasöründe başlangıç `CLAUDE.md`'si ve videodaki bütün promptlar sırasıyla duruyor.

## Sorun giderme

| Belirti | Çözüm |
|---|---|
| Ajan cevabında "The claude CLI is not installed" | `claude --version` çalışmıyor demek. Claude Code'u kur ve giriş yap. Başka bir yoldaysa: `CLAUDE_BIN=/tam/yol/claude npm start` |
| Ajanlar "offline" | İşçi çalışmıyor. `npm start` ile başlat ya da ayrı terminalde `npm run worker` |
| "reached its daily limit" | Usage sayfasından o ajanın günlük sınırını yükselt (yalnız oda sahibi) |
| `node:sqlite` hatası / testler patlıyor | Node sürümün eski. 22.18+ ya da 24 LTS kur |
| Her şeyi baştan almak | `npm run seed` |

## Lisans

MIT. Dilediğin gibi kullan, değiştir, kendi ekibine kur.
