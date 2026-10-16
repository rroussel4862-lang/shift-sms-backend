const fs = require("fs");
const path = require("path");
const vm = require("vm");

// The walk-through wording is a plain file people edit by hand (public/tour-texts.js).
// These checks catch a typo (missing quote or comma) or a missing language before it reaches staff.
function load(file, win) {
  const code = fs.readFileSync(path.join(__dirname, "..", "public", file), "utf8");
  vm.runInNewContext(code, { window: win, console });
}

let X, steps;
beforeAll(() => {
  const win = {};
  load("tour-texts.js", win);       // throws here if the file has a syntax error
  X = win.OSR_TOUR_TEXTS;
  load("tour.js", win);
  steps = win.OSRTour._steps;
});

describe("tour wording file", () => {
  test("loads and has entries", () => {
    expect(X && typeof X).toBe("object");
    expect(Object.keys(X).length).toBeGreaterThan(20);
  });

  test("every step in the tour has wording with a title and text in EN, FR and ES", () => {
    for (const tour of ["manager", "staff"]) {
      for (const st of steps[tour]) {
        expect(st.code).toBeTruthy();
        const e = X[st.code];
        expect(e).toBeDefined();
        for (const lang of ["en", "fr", "es"]) {
          expect(Array.isArray(e[lang])).toBe(true);
          expect(e[lang]).toHaveLength(2);
          expect(String(e[lang][0]).trim().length).toBeGreaterThan(0);
          expect(String(e[lang][1]).trim().length).toBeGreaterThan(0);
        }
      }
    }
  });

  test("checklist lines and buttons/labels exist in all three languages", () => {
    const codes = ["C1", "C2", "C3", "C4", "C5", "C6", ...Array.from({ length: 13 }, (_, i) => "L" + String(i + 1).padStart(2, "0"))];
    for (const c of codes) {
      expect(X[c]).toBeDefined();
      for (const lang of ["en", "fr", "es"]) expect(String(X[c][lang] || "").trim().length).toBeGreaterThan(0);
    }
  });

  test("step codes are unique", () => {
    const all = [...steps.manager, ...steps.staff].map((s) => s.code);
    expect(new Set(all).size).toBe(all.length);
  });
});
