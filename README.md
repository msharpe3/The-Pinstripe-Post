# The Pinstripe Post

The Pinstripe Post is a hub for live Yankees scores, broadcast info, roster moves, headlines, and more, delivered fresh from the Bronx.

**Live site:** https://msharpe3.github.io/The-Pinstripe-Post/ 

## Features

- **Game:** the live game with score, inning, runners on base, count, and the current batter vs. pitcher. Before a game, it shows a countdown to first pitch, the probable starters with their season stats, and the Yankees lineup once it's posted.
- **Where to watch:** TV, streaming, radio, and Spanish-language broadcasts for each game.
- **Scores:** the last game's linescore and top Yankees performers, recent results, upcoming games, and AL East standings.
- **Roster:** the active roster, the injured list, and roster moves from the last 30 days.
- **Highlights:** official MLB video clips from the live game and the last several games, playable right on the page. During a live game, new clips show up every couple of minutes.
- **News:** the latest Yankees headlines, plus links to beat coverage.
- **Design:** a pinstripe theme with light and dark modes, built mobile-first.

## How it works

It's a static site (HTML, CSS, and plain JavaScript) with no build step, hosted on GitHub Pages. The page pulls game data directly from MLB's public Stats API in the browser.

- During a live game, the score refreshes every 15 seconds.
- Otherwise, the schedule refreshes every 5 minutes, or every minute when first pitch is close.
- Updates pause while the tab is in the background and resume when you come back.

## Files

| File | What it does |
| --- | --- |
| `index.html` | Page layout |
| `style.css` | Design tokens and styles |
| `app.js` | Data loading and rendering |
| `logo.png` | Header logo |
| `icon.svg` | Browser and home-screen icon |

## Disclaimer

This is an unofficial fan project. It's not affiliated with or endorsed by Major League Baseball or the New York Yankees. Team names and data belong to their respective owners. The artwork is original and doesn't use official logos.
