// Notyf-Instanz erstellen mit benutzerdefinierter Konfiguration
const notyf = new Notyf({
  duration: 8000, // Toast verschwindet nach 8 Sekunden
  position: { x: 'center', y: 'top' }, // Oben in der Mitte anzeigen
  types: [
    {
      type: 'warning',
      background: '#d49b17', // Gelber Hintergrund für Time-Outs
      icon: {
        className: 'fas fa-exclamation-triangle', // Font Awesome Icon für Warnung
        tagName: 'i',
        color: 'white', // Schwarze Farbe für das Icon
      },
    },
  ],
});

// Funktion, um die URL-Parameter auszulesen
function getUrlParams() {
  const params = new URLSearchParams(window.location.search);
  return {
    banned: params.has('banned'),
    timedOut: params.get('timed_out'), // Gibt das Datum zurück, falls vorhanden
  };
}

// URL-Parameter auslesen
const urlParams = getUrlParams();

// Aktionen basierend auf den Parametern ausführen
if (urlParams.banned) {
  notyf.error('Your account is banned. Please contact support.');
}

if (urlParams.timedOut) {
  const timeoutDate = new Date(urlParams.timedOut).toLocaleString();
  notyf.open({
    type: 'warning', // Benutzerdefinierter Typ "warning" für Time-Out
    message: `You are temporarily banned until ${timeoutDate}.`,
  });
}

 document.addEventListener("DOMContentLoaded", function () {
            new Typed("#typed-text", {
                strings: [
                    "Play Chess on Discord!", 
                    "Play Chess with Friends!", 
                    "Play Chess everywhere!", 
                    "All with Chessy ♕"
                ],
                typeSpeed: 50,       // Geschwindigkeit des Tippens
                backSpeed: 30,       // Geschwindigkeit beim Löschen
                backDelay: 1000,     // Wartezeit vor dem Löschen
                startDelay: 500,     // Wartezeit bevor das erste Wort erscheint
                loop: true,          // Wiederholen der Animation
                smartBackspace: true // Verhindert Löschen gemeinsamer Präfixe
            });
        });


$(document).ready(function () {
    const tiltElement = $(".tilt");

    // CSS-Übergang für sanftes Zurücksetzen definieren
    tiltElement.css({
        "transition": "transform 0.5s ease-out" // Dauer und Timing-Funktion für die Animation
    });

    // Globale Mausverfolgung außerhalb des Tilt-Elements
    $(document).on("mousemove", function (e) {
        // Überprüfen, ob die Maus sich außerhalb des Tilt-Elements befindet
        if (!$(e.target).closest(".tilt").length) {
            const tiltOffset = tiltElement.offset(); // Position des Tilt-Elements
            const tiltWidth = tiltElement.width();
            const tiltHeight = tiltElement.height();

            const centerX = tiltOffset.left + tiltWidth / 2;
            const centerY = tiltOffset.top + tiltHeight / 2;

            // Relative Mausposition basierend auf dem Tilt-Element
            const tiltX = Math.max(Math.min(((e.pageX - centerX) / (tiltWidth / 2)), 1), -1); // Eingrenzung auf -1 bis 1
            const tiltY = Math.max(Math.min(((e.pageY - centerY) / (tiltHeight / 2)), 1), -1); // Eingrenzung auf -1 bis 1

            // Begrenzte und gleichmäßige Bewegung in alle Richtungen
            const maxTilt = 30; // Maximaler Tilt in Grad

            tiltElement.css(
                "transform",
                `rotateX(${-tiltY * maxTilt}deg) rotateY(${tiltX * maxTilt}deg) scale(1.05)`
            );
        } else {
            // Tilt-Funktion deaktiviert, wenn Maus über dem Element
            tiltElement.css("transform", "rotateX(0deg) rotateY(0deg) scale(1.05)");
        }
    });

    // Deaktivieren von Hover-Interaktionen mit Tilt-Element
    tiltElement.off("mousemove mouseenter mouseleave");

    // Zurücksetzen des Tilt-Effekts, wenn die Maus die Webseite verlässt
    $(document).on("mouseleave", function () {
        tiltElement.css(
            "transform",
            `rotateX(0deg) rotateY(0deg) scale(1.05)` // Zurücksetzen auf Ursprung mit CSS-Übergang
        );
    });
});

function toggleMenu() {
  const menu = document.querySelector('.mobile-menu');
  menu.classList.toggle('show');
}

