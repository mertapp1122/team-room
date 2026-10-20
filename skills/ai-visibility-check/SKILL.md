---
name: ai-visibility-check
description: How we run an AI search visibility check for a brand. Use when someone asks how visible a brand is in AI answers (ChatGPT, Perplexity, Gemini, Google AI Overviews), wants a visibility audit, or needs a prompt set to track.
---

# AI visibility check

How often do AI engines mention and cite a brand? This is the manual version of the check, so the team can do it in a thread.

## 1. Pin down the brand
- Brand, website, category, location (if local) and two or three competitors.
- If it is a lead, read it from the CRM (`search_leads`, then `get_lead`); the CRM may already hold a past visibility number.

## 2. Build the prompt set
Write 10 prompts a real buyer would type, spread across:
- best-of ("best sourdough bakery in Izmir")
- comparison ("X vs Y")
- problem ("how do I …")
- local or near-me, if relevant
- brand questions ("is X good for …")

## 3. Check each engine
For ChatGPT, Perplexity, Gemini and Google AI Overviews, record per prompt: mentioned (yes/no), position in the answer, which source was cited, and the tone.
You cannot run these queries from the room. Either give the prompt set and checklist so someone can run them, or analyse AI answers people paste into the thread.

## 4. Score
- Visibility = prompts that mention the brand ÷ prompts checked, per engine and overall.
- Never make up results. If nothing was measured, write "not measured yet".

## 5. Report
- Two-line summary with the score (or "not measured yet").
- The three most important fixes, one each for GEO (entity facts and sources AI engines trust), AEO (answer-ready content and schema) and SEO (pages that rank and get cited).
- Suggest re-running the same prompt set every month to track the trend.
