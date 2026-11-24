# ALLIANCES

A multiplayer strategy game: hearts, Action Points, a shooting range, a dead-player jury, and a negotiated or last-standing finish.

## Run it on your own computer
1. Install Node 20 or newer and PostgreSQL.
2. `npm install`
3. Create a database, then start the server (replace the values):
   `DATABASE_URL=postgres://localhost/alliances PGSSL=off ADMIN_CODE=your-secret SESSION_SECRET=any-long-random-text npm start`
4. Open http://localhost:3000 and use the **Admin** button with your admin code.

## Put it online with Render
The game must run all the time. It hands out AP at 17:00 and shrinks the board by itself, so a host that puts the app to sleep when nobody visits will break it. Use a paid always-on web service (Render's "Starter" plan or higher, plus its small Postgres database). Check Render's current prices before you commit.

1. Create a free GitHub account and a new private repository. Upload this whole folder to it.
2. Create a Render account and choose **New > Blueprint**. Connect the repository. Render reads `render.yaml` and sets up the web service and the database together.
3. When asked for `ADMIN_CODE`, enter a long secret. Anyone with it controls the game. `SESSION_SECRET` is generated for you.
4. Wait for the first deploy to finish, then open the link Render gives you. That link is what you share with players.
5. Log in with **Admin**, add players (a name and a 7-digit code each), choose your settings, then press **Start**.

## Before a real game
- Run a practice game with a few test accounts first, then use **Reset**.
- Turn on shrinking and choose the endgame mode in the admin settings.
- Give each player their own code privately.

## Tests
`npm test` runs the automated checks.
