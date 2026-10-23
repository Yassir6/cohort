# Cohort

A shared board for a class: exams, homework, announcements and course files in one place, kept up to date by the students themselves.

- **Up next**: every deadline from the courses you track, on a timeline with one stop per day, sorted by what's due first, with a live countdown to the next one, plus the latest announcements.
- **Courses**: anyone can add a course; each student tracks the ones they take.
- **Posts**: Exam, Homework, Announcement or Material, with date, time, room or submission place, grade weight, details and file uploads (up to 25 MB each).
- **Votes and comments** on every post. Three or more net upvotes mark a post *Confirmed*; two net downvotes mark it *Disputed*. Students can reply to a comment, attach files to comments and replies (up to 6, shown side by side as small previews or file links; hover a cut-off name to see it in full), edit their own comments and their files (marked *edited*), and type `@` to mention a classmate.
- **Notifications**: a bell shows new posts in your courses, date changes, replies to your comments, comments on your posts and @mentions of you. Opening it marks them read.
- **Edits keep history**: every edit makes a new version, the post shows it was edited, and the history page shows each version with the changes highlighted. A changed date gets a warning banner for two weeks.
- **Deleting needs agreement**: a student asks to delete with a reason, and the post is deleted only when 5 students agree.
- **Calendar**: month view, plus a personal calendar feed for Google, Apple or Outlook Calendar with a reminder the day before.
- **Done**: an exam or homework is done for the whole class once its due time passes. To mark it done earlier, students vote inside the post; when 6 agree (the first plus 5 others) it is done for everyone and leaves Up next.
- **Live**: changes from classmates appear without reloading.
- **Accounts**: a username (the name classmates see) and a password, no email. *Keep me signed in* keeps a student signed in until they sign out. The device key shown at sign-up gets them back in if they forget the password, and they then choose a new one.
- **Look around first**: visitors can skip sign-up and read everything: the timeline for all courses, posts, comments, the calendar, activity and search. Voting, posting, commenting, marking done and tracking ask them to create an account first. The class code is still needed to sign up.
- **Add to home screen**: on phones the profile menu offers it. Android shows the install prompt; iPhone shows the Safari steps.

## Run it

Needs Node.js 22.5 or newer. There are no packages to install.

```sh
npm start            # http://localhost:8090
```

Or with Docker:

```sh
docker compose up -d --build
```

All data lives in one folder (`./data`, or the `cohort-data` volume in Docker): `cohort.db` plus an `uploads/` folder.

## Settings

Set these as environment variables.

| Variable | Default | What it does |
| --- | --- | --- |
| `PORT` | `8090` | Port to listen on |
| `HOST` | `0.0.0.0` | Address to listen on |
| `DATA_DIR` | `./data` | Where the database and uploads are kept |
| `APP_NAME` | `Cohort` | Name shown in the app and in calendar feeds |
| `JOIN_CODE` | empty | When set, new students must enter this class code to join |
| `DELETE_VOTES` | `5` | How many students must agree before a post is deleted |
| `DONE_VOTES` | `6` | How many students must agree before an exam or homework is done early |
| `MAX_UPLOAD_MB` | `25` | Largest file a student can upload |
| `TRUST_PROXY` | off | Set to `1` behind a reverse proxy (Traefik, nginx) so rate limits see real visitor addresses |
| `PUBLIC_URL` | from the request | Full address used in calendar feed links, e.g. `https://cohort.example.com` |

Share `https://your-address/?code=YOURCODE` to fill in the class code for classmates automatically.

## Moderation

```sh
node admin.js                       # list commands
node admin.js deleted               # posts removed by vote
node admin.js restore <postId>      # bring one back
node admin.js remove-post <postId>  # remove spam right away
node admin.js block <studentId>     # stop a profile from posting
node admin.js new-key <studentId>   # new device key for a student who lost password and key
node admin.js delete-course <courseId>  # remove a course and everything in it for good (back up first)
node admin.js backup                # safe copy of the database
```

In Docker, prefix with `docker exec cohort`, e.g. `docker exec cohort node admin.js stats`.

## Backups

`node admin.js backup` writes a consistent copy of the database even while the app runs. Copy the `uploads/` folder alongside it. In Docker:

```sh
docker exec cohort node admin.js backup /data/backup.db
docker cp cohort:/data ./cohort-backup
```

## Accounts and recovery

Students sign up with a username and a password (at least 8 characters). Sign-in ignores capitals, spaces and dots, so `yasir a` finds `Yasir A.`. Passwords are stored as scrypt hashes; the session lives in an HttpOnly cookie. With *Keep me signed in* the session lasts until the student signs out (the cookie is renewed on every visit); without it, it ends when the browser closes or after 12 idle hours.

Sign-up shows a device key once. If a student forgets their password, they choose *Use your device key* on the sign-in screen and then set a new password; changing a password signs out their other devices. A new device key can be made from the profile at any time. If a student loses both, run `node admin.js new-key <studentId>` and give them the new key.

Accounts created before passwords existed are signed in once with the device key their browser saved, then asked to choose a password.
