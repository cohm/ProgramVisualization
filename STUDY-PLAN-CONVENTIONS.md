# How KTH study plans are written: observed differences between programmes

KTH schools run different kinds of programme, so some of what follows is a
legitimate consequence of different needs — a two-year master's programme has
little reason to describe elective space the way a five-year civilingenjör
programme does. Still, several of the differences below look incidental rather
than deliberate: the same fact is recorded in different places, or in prose in
one programme and in structured fields in another. Where that is the case, one
convention is usually easier to read, to maintain and to consume programmatically
than the other, and it seems worth comparing notes across schools.

These are observations, not conclusions. They were gathered while building a tool
that renders utbildningsplaner from KTH's published data (see `CLAUDE.md`), so the
lens is deliberately narrow: what is machine-readable, what is consistent, and
what needs a human to interpret. Anyone who owns one of these programmes will
know better than we do whether a difference is meaningful.

Everything is dated and sourced so it can be re-checked. Figures were measured in
August 2026 over eight programmes: **CTFYS, CTMAT, CFATE, COPEN** (owned by SCI,
Teknikvetenskap) and **CINEK, TIEMM, CMAST, CMATD** (owned by ITM, Industriell
teknik och management).

---

## 1. Elective space: stated as a number in some programmes, only in prose in others

Full-time study is 15 hp per period, so a year's courses should add up to 15 in
every period. Where they do not, the gap is normally the space for *valfria
kurser*. That space is real, and students need to see it — but how it is recorded
varies:

| programme | how elective space is discoverable |
|---|---|
| CTMAT | prose, **with a figure**: *"Utrymmet för valfria kurser är 7,5 hp per period hela läsåret."* |
| CTFYS | prose, **with a figure**: *"På våren i årskurs 3 finns ett utrymme på 15,0 hp valfria kurser."* |
| TIEMM | prose, **no figure**: *"…kan du även välja några helt valfria kurser."* |
| CFATE | not stated; the gap has to be inferred from the credit arithmetic |
| CMAST | not stated; a uniform 4.5 hp gap in year 2 P3 and P4 across all inriktningar |

The two programmes that give a figure are the two where the space can be filled
in automatically and checked — the stated amount matched the computed shortfall in
both cases. Where no figure is given, the arithmetic still reveals *that* space
exists, but not how it is meant to be distributed.

**Suggestion.** Stating elective space as a number, per period, is materially
more useful than stating it qualitatively — and more useful still would be
expressing it as an entry in the plan rather than as prose, so it does not have to
be recovered by subtraction. The wording CTMAT uses reads well and is
unambiguous: *"Utrymmet för valfria kurser är N hp per period."*

## 2. "Villkorligt valfri" is used for two different things

`electiveCondition: VV` marks a course as villkorligt valfri. Two distinct
situations are recorded the same way:

- **A genuine choice.** CTFYS year 3 lists `EF112X` and `SA114X` — pick one, both
  15 hp in P3+P4. This is a clean pick-one group and renders as one.
- **A pool with a credit threshold.** CFATE year 3 lists 36 hp of obligatorisk
  courses plus a 15 hp thesis choice, leaving 3 hp of the 60 — but then lists five
  villkorligt valfria courses totalling 26 hp. The student takes a subset. The
  intent is "minst N hp ur denna grupp", which the VV flag cannot express.

The second case is not detectable from the flag alone; it only shows up as a
period summing past full-time. CMAST year 3 shows the same shape for several
inriktningar.

**Suggestion.** Where the requirement is "at least N hp from this set", recording
the threshold alongside the set would remove the ambiguity. As published, a
consumer cannot distinguish "choose one of these" from "choose 3 hp worth of
these" without doing credit arithmetic and guessing.

## 3. A "group" of one

15 of 34 option groups extracted across the programmes contained exactly **one**
course — 5 of CFATE's 7 and 10 of TIEMM's 23. Kopps marks these villkorligt
valfri, but a choice between one alternative is not a choice, and none of the six
hand-curated study plans in this project models them as groups.

This is probably an artefact of how the plan was entered rather than an intent.
Worth a look by whoever maintains those plans: either the group is missing its
other members, or the course is effectively obligatorisk within that inriktning.

## 4. Structure splits by school; wording does not

Two things vary independently, and it is useful to keep them apart.

**Structure follows the owning school.** The SCI programmes return a single
curriculum with no inriktningar in years 1–3. The ITM programmes split by
inriktning from year 2:

| programme | school | inriktningar in years 1–3 |
|---|---|---|
| CTFYS, CTMAT, CFATE, COPEN | SCI | 0 |
| CINEK | ITM | 4 |
| CMATD | ITM | 4–6 |
| CMAST | ITM | 3 in year 2, **14** in year 3 |

Both conventions are defensible — the SCI programmes genuinely do not branch
before the master's choice. But the difference means a consumer must handle both,
and CMAST year 3 (15 parallel curriculum variants) is an order of magnitude more
complex than anything on the SCI side.

**Wording does not follow the school**, because prerequisite text belongs to the
*course*, not the programme: 23 courses appear in both an SCI and an ITM programme
and carry identical text in each. The variation tracks the department that owns
the course and the cycle level. TIEMM, a master's programme, is the outlier on
every measure (80 % of its prerequisite texts use "motsvarande", against 15–29 %
for the bachelor programmes).

## 5. `electiveCondition: R` is used by one programme only

CMAST records 144 participations with `electiveCondition: R` (rekommenderad) —
courses recommended for the master track a given inriktning leads to. None of the
other seven programmes uses this value at all.

It is genuinely useful information: it answers "what should I put in my elective
slots?", which none of the other programmes answers in structured form. But
because only one programme uses it, a consumer that has not met CMAST will not
know the value exists.

**Suggestion.** This looks like the better convention, not the deviant one. If
recommended-course-per-track were recorded this way across programmes, the
"elective space" problem in §1 would largely solve itself: the space and the
suggested ways to fill it would both be structured data. Worth discussing whether
CMAST's practice should spread rather than be normalised away.

## 6. Prerequisites: free text carrying structured intent

Prerequisites are published only as prose, in the syllabus *Särskild behörighet*
field, while what they express is almost always structured: a set of courses and a
requirement type. Recurring patterns:

```
"Aktivt deltagande i SF1673 Analys i en variabel."               -> participation
"Slutförd kurs SF1672 Linjär algebra"                            -> completed
"SG1112 Mekanik I eller motsvarande"                             -> completed, type implicit
"Kunskaper … motsvarande slutförd kurs DD1310-DD1319/DD1331/…"    -> a long alternative list
"…slutfört moment LAB1 i SH1017"                                 -> one module of another course
"Minst 104 högskolepoäng … ska vara avklarade"                    -> a credit threshold
```

Four specific frictions, each of which needed a rule to work around:

1. **Type is often implicit.** "SG1112 Mekanik I eller motsvarande" does not say
   whether the course must be completed or merely attended. The distinction
   matters — one must finish before the course starts, the other may run in
   parallel.
2. **Requirements are not reliably separated.** EI1320's 2026 syllabus runs two
   requirements together with no punctuation between them: *"…motsvarande slutförd
   kurs SI1200 eller SF1693 Kunskaper i grundläggande elektromagnetism…,
   motsvarande slutförd kurs SK1104/SH1017…"*. Read as one clause, two independent
   requirements look like alternatives.
3. **Alternative sets are written two ways** — slash lists (`DD1331/DD1337`) and
   hyphen ranges (`DD1310-DD1319`) — sometimes both in one sentence. 43 range
   expressions appear across the eight programmes.
4. **Lists of qualifying courses go stale.** DD1385 and DD1380 ask for knowledge
   in programming and list `DD1310/DD1311/…/DD1331` — but not `DD1333`, which is
   CTMAT's own first-year programming course. Neither syllabus has been revised
   since HT2021. DD1328 had the same omission and it *was* fixed in its 2026
   revision, which shows the process works when someone notices.

**Suggestion.** Point 4 is the one with a clear owner: when a course lists the
courses that satisfy a knowledge requirement, that list needs revisiting whenever
a programme introduces a new course covering the same ground. Points 1–3 are
about wording, and a short house style would help — always state "slutförd" or
"aktivt deltagande" explicitly, and start each requirement as its own sentence.

## 7. Where the same fact lives in different places

Smaller observations, each costing a consumer a special case:

- **Course period data is authoritative in one place and stale in another.** The
  KOPPS API returns an older syllabus version than the course page for 51 of 217
  courses checked. Since KOPPS is being retired this is expected, but it is worth
  saying explicitly somewhere public that it should no longer be read.
- **A programme with no curriculum for a year says so in prose.** CFATE and CTFYS
  both explain in `supplementaryInformation` that years 4–5 are taken inside a
  master's programme. COPEN has no year 2–3 curriculum at all, and that is only
  discoverable by finding zero courses listed.
- **Known data errors are documented in prose.** CTMAT's plan says: *"En bugg gör
  tyvärr att fel poängfördelning för SA1006 visas i studentgränssnittet."*
  Honest and helpful to a human reader, invisible to anything automated.
- **Selecting a historical course version is no longer possible in the UI.** The
  `?startterm=` parameter is ignored; only the current round is shown. The full
  version history is still present in the page's own data, and in PDF form in the
  kursutveckling archive, but a programme director cannot browse to the version a
  past cohort actually studied.

---

## Summary of what seems to work best

Drawn from the above, and offered for discussion rather than as recommendations:

| topic | the convention that reads best | seen in |
|---|---|---|
| elective space | stated as hp per period, in the plan rather than in prose | CTMAT (prose with figure) |
| recommended courses | structured per inriktning, not described in text | CMAST (`R`) |
| credit-threshold groups | threshold recorded with the set | nowhere yet |
| prerequisite type | "slutförd" / "aktivt deltagande" always explicit | CTFYS, mostly |
| requirement separation | one sentence per requirement | most, but not EI1320 |
| qualifying-course lists | reviewed when a programme adds a covering course | DD1328 (fixed 2026) |

None of this is urgent. But since several of these are already done well
*somewhere* at KTH, harmonising is mostly a matter of picking whichever
convention already exists rather than inventing anything.
