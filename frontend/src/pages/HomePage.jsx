import { useContext, useState } from "react";
import GuestCheckout from "../features/bookings/components/GuestCheckout.jsx";
import Icon from "../shared/components/Icon.jsx";
import SelectionSummary from "../features/seats/components/SelectionSummary.jsx";
import SeatSelection from "../features/seats/components/SeatSelection.jsx";
import ScreeningSelection from "../features/screenings/components/ScreeningSelection.jsx";
import CustomerAccount from "../features/account/components/CustomerAccount.jsx";
import { CustomerSessionContext } from "../features/account/CustomerSessionContext.js";

function CustomerAccountSlot() {
  const sessionModel = useContext(CustomerSessionContext);
  return sessionModel ? <CustomerAccount /> : null;
}

export default function HomePage() {
  const [checkout, setCheckout] = useState(null);
  const [browseChoices, setBrowseChoices] = useState(undefined);
  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="site-header shell">
        <a className="wordmark" href="#main" aria-label="RIO cinema home">
          RIO<span>cinema</span>
        </a>
        <nav className="header-actions" aria-label="Account and cinema">
          <CustomerAccountSlot />
          <a className="header-link" href="#cinemas">
            Find a screening <Icon name="arrow-up-right" />
          </a>
        </nav>
      </header>
      <main id="main" className="shell">
        <section className="hero" aria-labelledby="hero-title">
          <div className="hero-copy">
            <p className="eyebrow">Good films. Great company.</p>
            <h1 id="hero-title">
              Make room for
              <br />a great story.
            </h1>
            <p className="intro">
              Big-screen moments, a little closer to home.
              <br />
              Find your local RIO cinema.
            </p>
            <a className="primary-link" href="#cinemas">
              Find a screening <Icon name="arrow-down" />
            </a>
          </div>
          <div className="cinema-art" aria-hidden="true">
            <div className="art-frame">
              <Icon name="star-octogram" className="art-star" />
              <span className="art-caption">
                See you
                <br />
                at RIO.
              </span>
            </div>
            <span className="art-note">Lights down. Stories on.</span>
          </div>
        </section>
        {checkout ? (
          <GuestCheckout
            context={checkout}
            onBack={() => {
              setBrowseChoices({
                cityId: checkout.city.id,
                screenId: checkout.screen.id,
                filmId: checkout.film.id,
                screeningId: checkout.screening.id,
              });
              setCheckout(null);
            }}
          />
        ) : (
          <ScreeningSelection
            initialChoices={browseChoices}
            renderSeatSelection={(context) => (
              <SeatSelection
                screen={context.screen}
                screening={context.screening}
                renderSummary={(selection) => (
                  <SelectionSummary
                    {...context}
                    {...selection}
                    onCheckout={() =>
                      setCheckout({
                        city: context.city,
                        film: context.film,
                        screen: context.screen,
                        screening: context.screening,
                        showtime: context.showtime,
                        selected: selection.selected,
                      })
                    }
                  />
                )}
              />
            )}
          />
        )}
      </main>
      <footer className="site-footer shell">
        <span className="footer-brand">RIO</span>
        <p>Cinema in Finland. Stories for everyone.</p>
      </footer>
    </>
  );
}
