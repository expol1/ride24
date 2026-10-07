// Ride24 world explorer UI helper.
// Adds a readable country chooser and a safe "back to countries" view.
// It wraps existing homepage functions; it does not alter pricing/search/booking logic.
(() => {
  let cachedCountries = [];

  function currentLang() {
    return localStorage.getItem("lang") === "en" ? "en" : "pl";
  }

  function countryLabel(country, lang = currentLang()) {
    if (typeof window.getRide24CountryLabel === "function") {
      return window.getRide24CountryLabel(country, lang);
    }
    return country || "";
  }

  function countryFlag(country) {
    if (typeof window.getRide24CountryFlag === "function") {
      return window.getRide24CountryFlag(country);
    }
    return "🌍";
  }

  function applyLanguage() {
    if (typeof window.setLang === "function") {
      window.setLang(currentLang());
    }
  }

  function renderCountryChooser(countries) {
    const panel = document.getElementById("countryLocations");
    const title = document.getElementById("countryLocationsTitle");

    if (!panel) return;

    const list = Array.isArray(countries) ? [...countries] : [];
    cachedCountries = list;

    if (title) {
      title.dataset.pl = "Dostępne kraje";
      title.dataset.en = "Available countries";
      title.textContent = currentLang() === "en" ? "Available countries" : "Dostępne kraje";
    }

    panel.innerHTML = "";

    const intro = document.createElement("p");
    intro.className = "world-country-intro";
    intro.dataset.pl = "Wybierz kraj, aby zobaczyć dostępne miejsca odbioru.";
    intro.dataset.en = "Choose a country to see available pick-up locations.";
    intro.textContent = currentLang() === "en"
      ? "Choose a country to see available pick-up locations."
      : "Wybierz kraj, aby zobaczyć dostępne miejsca odbioru.";
    panel.appendChild(intro);

    if (!list.length) {
      const empty = document.createElement("div");
      empty.className = "world-map-empty";
      empty.dataset.pl = "Brak aktywnych krajów do wyświetlenia.";
      empty.dataset.en = "No active countries to display.";
      empty.textContent = currentLang() === "en"
        ? "No active countries to display."
        : "Brak aktywnych krajów do wyświetlenia.";
      panel.appendChild(empty);
      applyLanguage();
      return;
    }

    const grid = document.createElement("div");
    grid.className = "world-country-grid";

    list
      .sort((a, b) => countryLabel(a).localeCompare(countryLabel(b), currentLang()))
      .forEach(country => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "world-country-item";

        const main = document.createElement("span");
        main.className = "world-country-main";

        const flag = document.createElement("span");
        flag.className = "world-country-flag";
        flag.textContent = countryFlag(country);

        const name = document.createElement("span");
        name.className = "world-country-name";
        name.dataset.pl = countryLabel(country, "pl");
        name.dataset.en = countryLabel(country, "en");
        name.textContent = countryLabel(country);

        main.appendChild(flag);
        main.appendChild(name);
        button.appendChild(main);

        const sub = document.createElement("span");
        sub.className = "world-country-sub";
        sub.dataset.pl = "Pokaż lokalizacje";
        sub.dataset.en = "Show locations";
        sub.textContent = currentLang() === "en" ? "Show locations" : "Pokaż lokalizacje";
        button.appendChild(sub);

        button.addEventListener("click", () => {
          if (typeof window.loadLocations === "function") {
            window.loadLocations(country);
          }
        });

        grid.appendChild(button);
      });

    panel.appendChild(grid);
    applyLanguage();
  }

  function addBackToCountriesButton() {
    const panel = document.getElementById("countryLocations");
    if (!panel || !cachedCountries.length || panel.querySelector(".world-country-back")) return;

    const back = document.createElement("button");
    back.type = "button";
    back.className = "world-country-back";
    back.dataset.pl = "← Wszystkie kraje";
    back.dataset.en = "← All countries";
    back.textContent = currentLang() === "en" ? "← All countries" : "← Wszystkie kraje";
    back.addEventListener("click", () => renderCountryChooser(cachedCountries));
    panel.prepend(back);
    applyLanguage();
  }

  function install() {
    document.querySelectorAll(".world-map-btn").forEach(button => {
      button.dataset.pl = "Zobacz mapę";
      button.dataset.en = "View map";
      button.textContent = currentLang() === "en" ? "View map" : "Zobacz mapę";
    });

    const originalLoadCountries = window.loadCountries;
    if (typeof originalLoadCountries === "function" && !originalLoadCountries.__ride24Enhanced) {
      const wrappedLoadCountries = async function(...args) {
        const countries = await originalLoadCountries.apply(this, args);
        renderCountryChooser(countries || []);
        return countries;
      };
      wrappedLoadCountries.__ride24Enhanced = true;
      window.loadCountries = wrappedLoadCountries;
    }

    const originalRenderCountryLocations = window.renderCountryLocations;
    if (typeof originalRenderCountryLocations === "function" && !originalRenderCountryLocations.__ride24Enhanced) {
      const wrappedRenderCountryLocations = function(country, locations) {
        const sorted = Array.isArray(locations)
          ? [...locations].sort((a, b) =>
              String(a?.location_name || "").localeCompare(String(b?.location_name || ""), currentLang())
            )
          : locations;

        const result = originalRenderCountryLocations.call(this, country, sorted);
        addBackToCountriesButton();
        return result;
      };
      wrappedRenderCountryLocations.__ride24Enhanced = true;
      window.renderCountryLocations = wrappedRenderCountryLocations;
    }

    applyLanguage();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", install, { once: true });
  } else {
    install();
  }
})();
