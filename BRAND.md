# Free Me brand

Free Me's look is drawn from **Imigongo**, Rwanda's geometric cow-dung art, so the app is recognisably its own and not a
copy of other video apps. The same elements are used the same way everywhere (app, website, thumbnails, posters, social
media): recognition comes from consistency.

Code: `apps/web/src/app/globals.css` (colours and shapes), `apps/web/src/components/Logo.tsx` (mark and wordmark),
`apps/web/public/free-me.svg` and `apps/web/public/icons/` (app icons).

## The signature elements

| Element | What it is | Where |
| --- | --- | --- |
| **The mark** | Nested Imigongo diamonds, open on the right (a frame that lets you out), clay inner line, Kivu-teal core and dash | Header, app icon, favicon, sign-in |
| **The wordmark** | "free◆me" in Bricolage Grotesque ExtraBold, lower case, a clay diamond between the words | Header (phones from 400 px wide) |
| **The facet** | Two corners cut on the diagonal (top right, bottom left) instead of rounded corners: `facet`, `facet-sm`, `facet-lg` | Video thumbnails, cards, buttons, the player, the phone bar, a Space's picture |
| **The zigzag** | A thin clay Imigongo line: `zigzag` | Under section titles, the played part of the progress bar |
| **The band** | Clay and kaolin zigzags on black: `imigongo-band` | Along the bottom of the Spotlight |
| **The wall** | The Imigongo triangle pattern: `imigongo-wall` | A Space without its own banner |
| **The diamond** | `diamond` | The create (+) button on phones, the progress-bar handle |

## Colours

| Name | Light | Dark | Use |
| --- | --- | --- | --- |
| Ink | `#1b1612` | `#14110f` (background) | Text on light, the dark background |
| Kaolin | `#f6f0e7` (background) | `#f4ede3` | The light background, text on dark |
| Clay | `#c24e2b` | `#d65f36` | The brand: mark, zigzag, the create button, the current tab. Never errors |
| Kivu | `#0e857d` | `#22ada2` | Actions: Tune in, Create, Watch, links |
| Sorghum | `#e3a63a` | `#e8b04a` | Highlights: Spotlight, Spark, Premium |
| Error red | `#b42318` | `#ff6b6b` | Errors only |

## Type

- **Bricolage Grotesque** (display: headings, the wordmark), self-hosted, SIL Open Font License.
- **Inter** (everything else).

## Words

Our own names for things are part of the brand. Use them, but every button also shows a plain label or icon people
already know, so nobody is confused:

- Home, Following, Moments, Explore, You (the main places);
- **Space** (a creator's page), **Tune in** (follow), **Spark** (like a video), **Moments** (short videos);
- Share and Save on buttons (plain words new users understand at once).

## People's pictures

One picture follows a person everywhere: the header, the phone bar, comments, Moments, messages, video cards. A Space
without a picture of its own shows its owner's profile picture (`apps/api/src/users/pictures.ts`); a Space picture
uploaded for the Space wins. People are round; a Space's own page shows its picture with the facet. A picture that
cannot load shows the first letter on a fixed colour, never a broken image.

## Protecting it (trade dress)

Not legal advice: confirm each step with an intellectual-property lawyer in Rwanda.

1. **Register the mark and the wordmark** as trademarks (Rwanda Development Board, Office of the Registrar General),
   and in other countries Free Me grows into (Madrid System).
2. **Register the designs** of the main screens and icons as industrial designs where the law allows it.
3. **Check the name** "Free Me" early: it may already be registered for similar services or be hard to protect.
4. **Use the elements consistently** and keep dated records (screenshots, campaigns, press) that show people recognise
   them: protection for a look usually depends on recognition built over time.
5. Keep the elements decorative: the cut corners, zigzag, band and colours are style, not how the app works, which is
   what makes them protectable. A play button or a bottom menu bar is not.
