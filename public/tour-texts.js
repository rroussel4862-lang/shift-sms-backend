/* ==========================================================================================================
   OPEN SHIFT RAIL — WALK-THROUGH WORDING  (every bubble, button and checklist line, in EN / FR / ES)

   HOW TO EDIT
   - Each line has a CODE (M01, S02, C3 …). To see the code on screen while you test, add  ?codes=1  to the
     address (for example  https://openshiftrail.com/?codes=1 ). Add  ?codes=0  to turn it off again.
   - Bubbles (M01–M11 manager, S01–S04 staff) are  [ "Title", "Text" ].
     Checklist lines (C1–C6) and buttons/labels (L01–L13) are just one piece of text.
   - Only change what is between the quotes. Keep the quotes, the commas and the square brackets.
     If you need a quote mark inside the text, write it as \"  (backslash first), or use ’ instead of '.
     Emojis are fine.
   - Don't delete a language. If one is missing the English shows instead.
   - After editing: replace the file in public/, then  git add .  /  git commit  /  git push  and hard-refresh.
     (The test  npm test  checks this file, so a typo gets caught before it reaches your staff.)
   ========================================================================================================== */
window.OSR_TOUR_TEXTS = {

  /* ---------------------------------------------------------------- MANAGER TOUR (11 bubbles) */

  M01: { // MI · Overview — welcome
    en: ["Hey boss! 👋", "Welcome to Open Shift Rail. Two minutes, and you'll see how the whole machine fits together. Skip anytime."],
    fr: ["Salut, boss ! 👋", "Bienvenue sur Open Shift Rail. Deux minutes pour voir comment toute la machine s'emboîte. Vous pouvez passer en tout temps."],
    es: ["¡Hola, jefe! 👋", "Bienvenido a Open Shift Rail. En dos minutos verás cómo encaja toda la máquina. Puedes saltarlo cuando quieras."],
  },
  M02: { // MI · Overview — the page itself
    en: ["Your command center", "Open shifts, who's working, what needs you. Everything we're about to visit feeds this page."],
    fr: ["Votre poste de commande", "Quarts ouverts, qui travaille, ce qui demande votre attention. Tout ce qu'on va visiter alimente cette page."],
    es: ["Tu centro de mando", "Turnos abiertos, quién trabaja y qué necesita tu atención. Todo lo que vamos a visitar alimenta esta página."],
  },
  M03: { // MI · Staff — the add-staff form
    en: ["Meet your crew", "Add each person with their name, phone and roles. That's all we need."],
    fr: ["Faites connaissance avec votre équipe", "Ajoutez chaque personne avec son nom, son téléphone et ses rôles. C'est tout ce qu'il nous faut."],
    es: ["Conoce a tu equipo", "Agrega a cada persona con su nombre, teléfono y roles. Eso es todo lo que necesitamos."],
  },
  M04: { // MI · Staff — the Send login button
    en: ["No more group chats", "Hit Send login and they get a text, set up their phone, and see their own shifts."],
    fr: ["Fini les groupes de texto", "Appuyez sur Envoyer l'accès : chaque employé reçoit un texto, configure son téléphone et voit ses propres quarts."],
    es: ["Se acabaron los chats grupales", "Toca Enviar acceso y recibirán un mensaje, configurarán su teléfono y verán sus propios turnos."],
  },
  M05: { // BO · Schedule — the grid
    en: ["Your week on one grid", "Tap a cell to add a shift, drag one to move it. Your sales sit right on top of the days."],
    fr: ["Votre semaine sur une seule grille", "Touchez une case pour ajouter un quart, glissez-en un pour le déplacer. Les ventes sont juste au-dessus des jours."],
    es: ["Tu semana en una sola cuadrícula", "Toca una celda para agregar un turno, arrastra uno para moverlo. Las ventas están justo encima de los días."],
  },
  M06: { // BO · Schedule — the AI scheduler
    en: ["Blank week? Ask the AI 🪄", "It knows who's available, who does what, and what sales to expect. Or tap Copy last week and be done."],
    fr: ["Semaine vide ? Demandez à l'IA 🪄", "Elle sait qui est disponible, qui fait quoi et quelles ventes prévoir. Ou touchez Copier la semaine dernière et c'est réglé."],
    es: ["¿Semana en blanco? Pídele a la IA 🪄", "Sabe quién está disponible, quién hace qué y cuántas ventas esperar. O toca Copiar la semana pasada y listo."],
  },
  M07: { // BO · Schedule — draft / Post schedule
    en: ["Work in private", "Next week stays a draft that staff can't see. When you're happy, hit Post schedule and it shows up in their app."],
    fr: ["Travaillez en privé", "La semaine prochaine reste un brouillon invisible pour l'équipe. Quand c'est bon, touchez Afficher l'horaire et il apparaît dans leur appli."],
    es: ["Trabaja en privado", "La próxima semana queda como borrador que el equipo no ve. Cuando estés conforme, toca Publicar horario y aparece en su app."],
  },
  M08: { // BO · Sales
    en: ["Feed the machine", "Enter food and beverage sales per service. The AI forecasts from your history, and these numbers shape your schedule."],
    fr: ["Nourrissez la machine", "Entrez les ventes de nourriture et de boissons par service. L'IA prévoit à partir de votre historique, et ces chiffres guident votre horaire."],
    es: ["Alimenta la máquina", "Ingresa las ventas de comida y bebidas por servicio. La IA pronostica con tu historial, y estas cifras guían tu horario."],
  },
  M09: { // BO · Schedule — the Actual sales row
    en: ["See that?", "Your actual sales show up in the grid on their own. No double entry."],
    fr: ["Vous voyez ça ?", "Vos ventes réelles apparaissent toutes seules dans la grille. Aucune double saisie."],
    es: ["¿Ves eso?", "Tus ventas reales aparecen solas en la cuadrícula. Sin doble captura."],
  },
  M10: { // BO · Punch clock
    en: ["Who was really here?", "Log when each person actually clocked in and out. Those times replace the scheduled ones, and payroll gets the real hours."],
    fr: ["Qui était vraiment là ?", "Notez l'heure réelle d'arrivée et de départ de chacun. Ces heures remplacent celles de l'horaire, et la paie reçoit les vraies heures."],
    es: ["¿Quién estuvo de verdad?", "Registra cuándo entró y salió cada persona. Esas horas reemplazan las del horario y la nómina recibe las horas reales."],
  },
  M11: { // MI · Overview — wrap-up
    en: ["That's the loop 🔁", "Crew → schedule → sales → punches → payroll, with AI helping at every turn. Now go run your floor. 🍽️"],
    fr: ["Voilà la boucle 🔁", "Équipe → horaire → ventes → pointages → paie, avec l'IA qui aide à chaque étape. Maintenant, allez mener votre salle. 🍽️"],
    es: ["Ese es el ciclo 🔁", "Equipo → horario → ventas → registros → nómina, con la IA ayudando en cada paso. Ahora ve a dirigir tu salón. 🍽️"],
  },

  /* ---------------------------------------------------------------- STAFF TOUR (4 bubbles, staff portal) */

  S01: { // My schedule
    en: ["Here's your schedule 📅", "Your upcoming shifts live here. Peek before you make plans!"],
    fr: ["Voici ton horaire 📅", "Tes prochains quarts sont ici. Jette un œil avant de faire des plans !"],
    es: ["Este es tu horario 📅", "Tus próximos turnos están aquí. ¡Échale un vistazo antes de hacer planes!"],
  },
  S02: { // Availability tab
    en: ["Tell us when you're free", "Set your availability and time off. Your manager plans around it."],
    fr: ["Dis-nous quand t'es libre", "Entre tes disponibilités et tes congés. Ton gestionnaire planifie en fonction de ça."],
    es: ["Dinos cuándo estás libre", "Indica tu disponibilidad y tus días libres. Tu gerente planea en base a eso."],
  },
  S03: { // Open shifts tab
    en: ["Grab a shift", "Open shifts and shifts coworkers want to hand off show up here. Tap one to take it."],
    fr: ["Prends un quart", "Les quarts ouverts et ceux que des collègues veulent céder apparaissent ici. Touches-en un pour le prendre."],
    es: ["Toma un turno", "Aquí aparecen los turnos abiertos y los que tus compañeros quieren ceder. Toca uno para tomarlo."],
  },
  S04: { // Board tab
    en: ["The Board has the news 📣", "Announcements from your manager land here. Check in once in a while."],
    fr: ["Le babillard a les nouvelles 📣", "Les annonces de ton gestionnaire arrivent ici. Viens y jeter un œil de temps en temps."],
    es: ["El tablón tiene las novedades 📣", "Los anuncios de tu gerente llegan aquí. Pásate de vez en cuando."],
  },

  /* ---------------------------------------------------------------- "GETTING STARTED" CHECKLIST (manager Overview) */

  C1: { en: "Add your first team member", fr: "Ajouter votre premier employé", es: "Agrega a tu primer empleado" },
  C2: { en: "Send a login", fr: "Envoyer un accès", es: "Envía un acceso" },
  C3: { en: "Set your services & hours", fr: "Régler vos services et heures", es: "Configura tus servicios y horarios" },
  C4: { en: "Create your first schedule (AI or by hand)", fr: "Créer votre premier horaire (IA ou à la main)", es: "Crea tu primer horario (con IA o a mano)" },
  C5: { en: "Enter sales for a day", fr: "Entrer les ventes d'une journée", es: "Ingresa las ventas de un día" },
  C6: { en: "Post a week to your staff", fr: "Publier une semaine à votre équipe", es: "Publica una semana para tu equipo" },

  /* ---------------------------------------------------------------- BUTTONS & LABELS */

  L01: { en: "Next", fr: "Suivant", es: "Siguiente" },                                       // bubble button
  L02: { en: "Back", fr: "Retour", es: "Atrás" },                                             // bubble button
  L03: { en: "Skip tour", fr: "Passer la visite", es: "Saltar el recorrido" },                // bubble link
  L04: { en: "Let's go!", fr: "C'est parti !", es: "¡Vamos!" },                               // button on the LAST bubble
  L05: { en: "Replay the walk-through", fr: "Revoir la visite guidée", es: "Repetir el recorrido" }, // tooltip of the round ? button
  L06: { en: "Tour paused ⏸️", fr: "Visite en pause ⏸️", es: "Recorrido en pausa ⏸️" },       // title when someone comes back mid-tour
  L07: { en: "Want to pick up where you left off?", fr: "Voulez-vous reprendre là où vous étiez rendu ?", es: "¿Quieres seguir donde lo dejaste?" },
  L08: { en: "Continue", fr: "Continuer", es: "Continuar" },                                  // button in the paused bubble
  L09: { en: "Getting started 🚀", fr: "Pour bien démarrer 🚀", es: "Para empezar 🚀" },     // checklist card title
  L10: { en: "Hide", fr: "Masquer", es: "Ocultar" },                                          // checklist link
  L11: { en: "Replay the tour", fr: "Revoir la visite", es: "Repetir el recorrido" },         // checklist link
  L12: { en: "You're all set! 🎉", fr: "Tout est prêt ! 🎉", es: "¡Todo listo! 🎉" },         // checklist card when everything is done
  L13: {
    en: "Your restaurant is up and running. You can replay the tour any time with the ? button.",
    fr: "Votre restaurant est lancé. Vous pouvez revoir la visite en tout temps avec le bouton ?.",
    es: "Tu restaurante ya está en marcha. Puedes repetir el recorrido cuando quieras con el botón ?.",
  },
};
