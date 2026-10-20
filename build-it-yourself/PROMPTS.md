# Team Room'u sıfırdan kendin kur

Videoda Team Room'u boş bir klasörden başlayıp Claude Code'a sırayla bu promptları vererek kurdum. Sen de aynısını yapabilirsin. Bitmiş hali bu reponun kendisi; takılırsan karşılaştırırsın.

## Başlamadan

1. Boş bir klasör aç ve içinde `git init` çalıştır.
2. Bu klasördeki `CLAUDE.md`'yi oraya kopyala. `<YOUR NAME>` ve `<...business...>` yerlerini kendi bilgilerinle doldur. Teknik kurallar burada duruyor, promptlarda değil; promptlar bu yüzden kısa ve doğal.
3. O klasörde Claude Code'u aç. Videoda **Opus 5.5, high effort** kullandım.
4. Promptları **sırayla** ver. Her adımın sonunda Claude testleri koşar ve commit eder. Bir sonrakine geçmeden uygulamayı kendin aç ve bak (`npm start`, iki pencere: `?as=...`).

**Not:** Promptlarda geçen Ayşe, Scout, Northwind gibi adlar videodaki koşuda Claude'un seçtiği adlar. Senin odanda farklı çıkabilir; promptu kendi odandaki adlarla düzelt.

Promptlar videodakiyle birebir aynı. Yalnız 3. prompttaki kendi ürün adımı genel bir "AI visibility check" ile değiştirdim. İstersen Türkçe de yazabilirsin, Claude Code anlar.

## Videodaki süreler

Süre, Claude'un o adımda kendi bildirdiği çalışma süresi. Maliyet, oturumun jetonlarından hesaplanan API liste fiyatı karşılığı. Ben ödemeyi abonelikle yaptım, ayrıca fatura çıkmadı.

| Adım | Ne kuruldu | Claude süresi | API karşılığı |
|---|---|---|---|
| 1 | Ortak oda: kanallar, üyeler, canlı sohbet | 9 dk 30 sn | 2,60 $ |
| 2 | Ajanlar gerçekten çalışıyor (`claude -p`) | 16 dk 32 sn | 3,96 $ |
| 3 | Ortak skill'ler + demo CRM | 11 dk 40 sn | 3,41 $ |
| 4 | Kullanım, maliyet, günlük sınır | 15 dk 21 sn + 7 dk 18 sn | 5,75 $ + 1,38 $ |
| 5 | #sales iş akışı, check-in, profiller | 14 dk 19 sn | 5,75 $ |
| 6 | Fotoğraflar + Members sayfası | 3 dk 15 sn + 2 dk 9 sn | 8,50 $ (ikisi birlikte) |
| 7 | Kanal uygulamaları + pipeline panosu | 12 dk 39 sn | 3,76 $ |
| 8 | Yeni ajan formu + kişilik + profil | 9 dk 46 sn | 3,22 $ |
| **Toplam** | | **1 sa 42 dk** | **38,33 $** |

4. adımdaki ikinci satır, bilgisayarımın klasör izni yarıda kesildiği için verdiğim kısa bir devam promptu. Sende muhtemelen gerekmez.

---

## Prompt 1 · Ortak oda

```
Right now each of us uses AI alone: my Claude Code knows my skills and my stuff, and nobody else on the team can talk to it. I want to build our own team room, kind of like Slack, where people and agents sit in the same channels. Start with the basics: a few channels for the agency, a members list with people and agents, and live chat so two people in two browser windows see each other's messages instantly. Agents can just show up as members for now; we'll make them actually work in the next step.
```

## Prompt 2 · Ajanları gerçek yap

```
The room works: Ayşe's reply showed up in my window right away, but the agents just sit there saying "Not connected yet". Now make them real. When someone @mentions an agent, a worker on my computer should pick up that job, run it with claude -p on my own subscription and post the answer back in a thread, so everyone in the room sees it working and then sees the reply. Give each agent a small profile with its model and what it's good at, and show it offline when the worker isn't running.
```

## Prompt 3 · Ortak skill'ler ve araçlar

```
Scout answered in a thread in a couple of seconds, which is great, but right now the agents only know the chat. I want the things that make my own Claude useful to belong to the whole team: shared skills that every agent loads, starting with how we write agency offers and an AI visibility check, and a connections page where we hook up tools, for now a demo CRM with fake leads they can read. When Ayşe asks an agent for an offer, it should use our skill and the CRM instead of guessing. Keep it read-only and safe, like you said.
```

## Prompt 4 · Kullanım ve maliyet

```
Nice, the agent kept the $799 floor even for the lead with a $600 budget, and it used our skill and the CRM to do it. Now I need to see what all this costs. Log every agent run with who asked, which room, which agent and model, how long it took and the API-equivalent price claude reports, even though we pay with the subscription. Add a usage page with an overview and breakdowns by person, room and agent, plus a daily limit per agent so one runaway thread can't burn through the week.
```

> $799 benim örnek fiyat tabanım. Senin `CLAUDE.md`'ndeki fiyat neyse onu yaz.

## Prompt 5 · Takıma yaymak: #sales

```
The usage page is what I wanted: I can see who and which room is spending, and Scout stops when it hits its daily limit. Last step is rolling this out to the team without overwhelming anyone, so we start with one work stream: the sales pipeline in #sales. Give that channel a weekly commitments tracker so we can see who's done what, and an automation where an agent checks in with everyone at 5pm and nudges whoever owns a lead that hasn't moved in a day, with a button to run it now so I can try it. Add simple profiles for people too, with their role and what they're working on, so the agents know who to ask.
```

## Prompt 6 · Fotoğraflar

Önce fotoğrafları koy: `public/img/people/<üye-id>.jpg` (kendi fotoğrafın + ekip arkadaşları) ve ajan ikonu için `public/img/agents/claude.svg`. Bu repodaki portreleri ve ikonu kullanabilirsin. Dosya adları senin odandaki üye id'leriyle aynı olmalı.

```
The member list still shows letters in colored circles, so it doesn't feel like a real team yet. I put photos in public/img/people: my real photo for me and AI-generated portraits for the fictional teammates, so keep their demo tag and make it clear they're AI portraits. The agents all run on Claude, so give them the Claude icon from public/img/agents and an Agent label. Add All / People / Agents tabs to the members panel, and use the photos wherever a person's avatar shows up.
```

Aynı oturumda devam:

```
The photos look great and the tabs work, but the list is squeezed into that narrow sidebar, so the faces are tiny. Give Members its own page in the left sidebar, like Skills and Usage: a roomy list with bigger photos, the name and role on two lines, and the All / People / Agents tabs on top. Keep the sidebar panel as it is for quick looks.
```

## Prompt 7 · Kanal uygulamaları ve pipeline panosu

```
The Members page is exactly what I wanted; it finally feels like a team. Now the #sales pipeline only lives in chat messages and the demo CRM, and I want to see it at a glance. Give every channel an Apps tab where its apps show up as colorful preview cards, and build the first real one for #sales: a pipeline board with the demo leads as cards, one column per stage. When Ayşe drags a card to another column, it should move on my screen too, and a short line should go into #sales so the agents know. Put the weekly commitments tracker in that Apps tab as well.
```

## Prompt 8 · Herkes kendi ajanını kursun

```
The board is great: Ayşe dragged Northwind to Proposal, it jumped columns on my screen right away, and when I asked Pipeline what moved, it knew both moves. Now I want the team to make their own agents instead of asking me to edit the seed. Add a New agent form with a name, what it's good at, how smart it should be (Haiku for quick and cheap, Sonnet for everyday work, Opus for hard problems) and a short persona in three parts: who you are, how you think, how you sound. Every agent gets a profile page with its persona, model, who made it and what it has spent today, and the worker should pass the persona to claude so the agent really answers in that voice.
```

---

Her adımdan sonra iki pencereyle dene. Bir şey bozuksa bir sonraki prompta geçmeden Claude'a ne gördüğünü düz cümleyle söyle ("Ayşe'nin mesajı benim pencereme gelmedi" gibi).
