import { useCallback, useEffect, useRef, useState } from "react";
import { useSession } from "../../session/hooks/useSession.js";
import {
  calculateDerivedChildCents,
  createPriceAdminService,
  formatCentsAsEur,
  formatTimestamp,
  parseEuroInputToCents,
} from "../services/priceAdmin.js";

// Lukee hintarivistä senttiarvon tukien sekä camelCase- että snake_case-kenttiä,
// jotta komponentti ei hajoa vaikka taustajärjestelmän kenttänimi vaihtelisi.
const getCents = (row) => {
  if (!row || typeof row !== "object") return null;
  if (typeof row.amountCents === "number") return row.amountCents;
  if (typeof row.amount_cents === "number") return row.amount_cents;
  return null;
};

// Etsii hintariveistä kokonaislukuna olevan versionumeron, jotta päivityksessä
// voidaan lähettää expectedVersion ja estää kilpailevien muokkausten 409-konfliktit.
const getVersion = (rows) => {
  if (!Array.isArray(rows)) return undefined;
  for (const row of rows) {
    for (const key of ["version", "priceVersion", "price_version"]) {
      if (Number.isInteger(row?.[key])) return row[key];
    }
  }
  return undefined;
};

// Palauttaa viimeksi muokanneen käyttäjän tiedon (tai oletusarvon), jotta ylläpitäjä
// näkee kuka hinnan on viimeksi päivittänyt ilman että puuttuva tieto kaataa näkymän.
const getUpdatedBy = (row) =>
  row?.updatedByEmail ??
  row?.updated_by_email ??
  row?.updatedBy ??
  row?.updated_by ??
  "Not recorded";

// Palauttaa viimeisimmän muokkausajan raaka-arvon, jotta se voidaan muotoilla
// luettavaan muotoon vasta renderöinnissä.
const getUpdatedAt = (row) => row?.updatedAt ?? row?.updated_at ?? null;

export default function AdminPricesView() {
  // Haetaan istuntomalli ja luodaan priceAdmin-palvelu kerran komponentin elinkaaren aikana,
  // jotta API-pyynnöt käyttävät samaa istunto-/CSRF-logiikkaa eivätkä luo turhia instansseja.
  const { model } = useSession();
  const [service] = useState(() => createPriceAdminService(model));

  // Hintoihin ja lataukseen liittyvät tilat hallitsevat näkymän lataus-, onnistumis- ja virhenäkymiä.
  const [prices, setPrices] = useState([]);
  const [version, setVersion] = useState(undefined);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [reloadCount, setReloadCount] = useState(0);

  // Lomakkeen ja tallennuksen tilat erottavat käyttäjän syötteen, tallennusvaiheen,
  // 409-konfliktin ja tilaviesteistä kertovan palautteen selkeästi toisistaan.
  const [adultInput, setAdultInput] = useState("");
  const [isDirty, setIsDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [isConflict, setIsConflict] = useState(false);
  const [statusMessage, setStatusMessage] = useState("");

  // inputRef mahdollistaa fokuksen palauttamisen kenttään virheen jälkeen;
  // isMounted estää tilapäivitykset komponentin purkautumisen jälkeen.
  const inputRef = useRef(null);
  const isMounted = useRef(true);

  // Pidätään isMounted ajan tasalla, jotta keskeneräiset asynkroniset pyynnöt
  // eivät yritä päivittää React-tilaa sen jälkeen kun näkymä on suljettu.
  useEffect(() => {
    isMounted.current = true;
    return () => {
      isMounted.current = false;
    };
  }, []);

  // Hakee voimassa olevat hinnat palvelimelta ja päivittää näkymän.
  // isDirty ja preserveInput varmistavat, ettei lataus ylikirjoita kesken olevaa syötettä.
  const fetchPrices = useCallback(
    async (signal, preserveInput = false) => {
      setLoading(true);
      setLoadError("");
      try {
        const data = await service.listPrices(signal);
        if (!isMounted.current || signal?.aborted) return;

        const rows = Array.isArray(data) ? data : [];
        setPrices(rows);
        setVersion(getVersion(rows));

        const adultRow = rows.find((item) => item?.category === "adult");
        const adultCents = getCents(adultRow);
        if (!preserveInput && !isDirty && typeof adultCents === "number") {
          setAdultInput((adultCents / 100).toFixed(2));
        }
      } catch (err) {
        if (!isMounted.current || signal?.aborted || err?.name === "AbortError") {
          return;
        }
        setLoadError(
          err?.status === 403
            ? "You do not have permission to view or manage global prices."
            : "Could not load price configuration. Please try again.",
        );
      } finally {
        if (isMounted.current && !signal?.aborted) {
          setLoading(false);
        }
      }
    },
    [isDirty, service],
  );

  // Käynnistää hintojen haun ensi renderöinnissä ja aina kun reloadCount kasvaa.
  // AbortController peruu kesken jääneen pyynnön, jos komponentti päivittyy tai poistuu.
  useEffect(() => {
    const controller = new AbortController();
    fetchPrices(controller.signal, false);
    return () => controller.abort();
  }, [fetchPrices, reloadCount]);

  // Laskee lapsen hinnan esikatselun reaaliajassa syötteen perusteella, jotta ylläpitäjä
  // näkee puolitetun ja ylöspäin pyöristetyn hinnan jo ennen tallennusta.
  const parsedPreview = parseEuroInputToCents(adultInput);
  const previewChildCents =
    parsedPreview.amountCents != null
      ? calculateDerivedChildCents(parsedPreview.amountCents)
      : null;

  // Validoi syötteen, tallentaa uuden aikuisten hinnan versiotiedolla ja käsittelee
  // sekä onnistumisen että virhetilat (mukaan lukien 409-konflikti ilman hiljaista ylikirjoitusta).
  async function handleSubmit(event) {
    event.preventDefault();
    if (saving || loading) return;

    setSubmitError("");
    setIsConflict(false);
    setStatusMessage("");

    const parsed = parseEuroInputToCents(adultInput);
    if (parsed.error || typeof parsed.amountCents !== "number") {
      setSubmitError(parsed.error || "Enter a valid positive adult price.");
      inputRef.current?.focus();
      return;
    }

    setSaving(true);
    try {
      const result = await service.updateAdultPrice({
        amountCents: parsed.amountCents,
        expectedVersion: version,
      });
      if (!isMounted.current) return;

      // Jos tallennusvastaus sisältää päivitetyt rivit, käytetään niitä suoraan;
      // muuten haetaan tuoreet hinnat palvelimelta säilyttäen vahvistetun syötteen.
      const updatedRows = Array.isArray(result)
        ? result
        : Array.isArray(result?.prices)
          ? result.prices
          : null;

      if (updatedRows) {
        setPrices(updatedRows);
        setVersion(getVersion(updatedRows));
      } else {
        if (typeof result?.version === "number") {
          setVersion(result.version);
        }
        await fetchPrices(undefined, true);
      }

      const childCents = calculateDerivedChildCents(parsed.amountCents);
      setIsDirty(false);
      setAdultInput((parsed.amountCents / 100).toFixed(2));
      setStatusMessage(
        `Saved ${formatCentsAsEur(parsed.amountCents)} adult / ${formatCentsAsEur(childCents)} child.`,
      );
    } catch (err) {
      if (!isMounted.current || err?.name === "AbortError") return;

      // 409-konfliktissa estää hiljaisen ylikirjoituksen ja pyytää lataamaan ajantasaiset
      // hinnat, jotta ylläpitäjä ei jyrää toisen tekemää muutosta vahingossa.
      if (err?.status === 409) {
        setIsConflict(true);
        setSubmitError(
          "Price settings changed while you were editing. Reload the latest prices before saving again.",
        );
      } else if (err?.status === 403) {
        setSubmitError("Only active administrators can update global prices.");
      } else {
        setSubmitError(
          "Could not save price changes. Your entered value is kept so you can retry.",
        );
      }
      // Syötekenttä ja annettu arvo säilytetään, jotta käyttäjä voi korjata tai yrittää uudelleen helposti.
      inputRef.current?.focus();
    } finally {
      if (isMounted.current) {
        setSaving(false);
      }
    }
  }

  // Nollaa virhetilat ja käynnistää uuden haun. keepInput-asetuksella voidaan säilyttää
  // keskeneräinen arvo (esim. 409-konfliktin jälkeen) tai alustaa se tuoreesta aikuishinnasta.
  function handleRetry({ keepInput = false } = {}) {
    setLoadError("");
    setSubmitError("");
    setIsConflict(false);
    if (!keepInput) {
      setIsDirty(false);
    }
    setReloadCount((prev) => prev + 1);
  }

  // Lataustilan aikainen näkymä role="status"-määritteellä ruudunlukuohjelmia varten.
  if (loading) {
    return (
      <div role="status" aria-live="polite" className="status-banner">
        Loading price configuration…
      </div>
    );
  }

  // Latausvirhenäkymä ja Retry-painike, jotta käyttäjä voi yrittää hakea hinnat uudelleen
  // ilman koko sivun päivittämistä.
  if (loadError) {
    return (
      <div role="alert" className="error-panel">
        <p>{loadError}</p>
        <button
          type="button"
          className="primary"
          onClick={() => handleRetry({ keepInput: false })}
        >
          Retry
        </button>
      </div>
    );
  }

  // Poimitaan erikseen aikuisten ja lasten hintarivit sekä metatietojen lähderivin.
  const adultRow = prices.find((item) => item?.category === "adult");
  const childRow = prices.find((item) => item?.category === "child");
  const metaRow = adultRow ?? childRow ?? prices[0] ?? null;

  return (
    <section className="price-admin" aria-label="Price configuration">
      {/* Näyttää voimassa olevat hinnat, version ja viimeisimmän muokkauksen tiedot,
          jotta ylläpitäjä näkee nykytilan ja historiatiedot rinnakkain muokkauslomakkeen kanssa. */}
      <div className="price-summary" aria-label="Current prices">
        <h2>Current prices</h2>
        <p className="hint">
          Child tickets (age 12 and under) are half the adult price, rounded up
          to the nearest cent. Historical bookings and existing tickets are not
          repriced.
        </p>
        <dl className="price-meta">
          <div>
            <dt>Adult</dt>
            <dd>{formatCentsAsEur(getCents(adultRow))}</dd>
          </div>
          <div>
            <dt>Child (derived)</dt>
            <dd>{formatCentsAsEur(getCents(childRow))}</dd>
          </div>
          {version !== undefined && (
            <div>
              <dt>Version</dt>
              <dd>{version}</dd>
            </div>
          )}
          <div>
            <dt>Last updated</dt>
            <dd>{formatTimestamp(getUpdatedAt(metaRow))}</dd>
          </div>
          <div>
            <dt>Updated by</dt>
            <dd>{getUpdatedBy(metaRow)}</dd>
          </div>
        </dl>
      </div>

      {/* Lomake aikuisten hinnan päivittämiseen; noValidate antaa oman validoinnin
          tuottaa selkeät suomen-/englanninkieliset virheilmoitukset ja saavutettavat aria-viitteet. */}
      <form onSubmit={handleSubmit} noValidate className="price-form">
        <h2>Update global adult price</h2>
        <label htmlFor="adult-price-eur">Adult ticket price (EUR)</label>
        <input
          ref={inputRef}
          id="adult-price-eur"
          name="adultPriceEur"
          type="text"
          inputMode="decimal"
          autoComplete="off"
          disabled={saving}
          value={adultInput}
          onChange={(event) => {
            setIsDirty(true);
            setAdultInput(event.target.value);
            if (submitError) setSubmitError("");
            if (isConflict) setIsConflict(false);
          }}
          aria-invalid={Boolean(submitError)}
          aria-describedby="child-price-preview price-form-feedback"
        />

        {/* Esikatselu näyttää johdetun lapsen hinnan ennen tallennusta, jotta pyöristys
            on läpinäkyvä ennen kuin muutokset viedään palvelimelle. */}
        <p
          id="child-price-preview"
          className="price-preview"
          aria-live="polite"
        >
          <span>Derived child price before save: </span>
          <strong>
            {previewChildCents != null
              ? formatCentsAsEur(previewChildCents)
              : "Enter a valid adult price"}
          </strong>
        </p>

        {/* Onnistuneesta tallennuksesta kertova tilaviesti. */}
        {statusMessage && (
          <p role="status" className="status-message">
            {statusMessage}
          </p>
        )}

        {/* Virhe- ja konfliktiviesti: 409-tilanteessa käyttäjä voi ladata tuoreet
            hinnat säilyttäen syötteensä, ja muissa virheissä palata suoraan kenttään. */}
        {submitError && (
          <div id="price-form-feedback" role="alert" className="error-panel">
            <p>{submitError}</p>
            <button
              type="button"
              className="secondary"
              disabled={saving}
              onClick={() =>
                isConflict
                  ? handleRetry({ keepInput: true })
                  : inputRef.current?.focus()
              }
            >
              {isConflict ? "Reload latest prices" : "Retry"}
            </button>
          </div>
        )}

        {/* Tallennuspainike estää kaksoisklikkaukset tallennuksen aikana;
            Refresh prices mahdollistaa manuaalisen päivityksen. */}
        <div className="form-actions">
          <button type="submit" className="primary" disabled={saving}>
            {saving ? "Saving…" : "Save price"}
          </button>
          <button
            type="button"
            className="secondary"
            disabled={saving}
            onClick={() => handleRetry({ keepInput: false })}
          >
            Refresh prices
          </button>
        </div>
      </form>
    </section>
  );
}