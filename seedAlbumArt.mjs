import 'dotenv/config';
import mysql from 'mysql2/promise';

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT || 3306,
});

async function backfillAlbumArt() {
  const [songs] = await pool.query(`
    SELECT id, Title, Artist
    FROM songs
    WHERE album_art_url IS NULL OR album_art_url = ''
  `);

  for (const song of songs) {
    try {
      const term = `${song.Title} ${song.Artist}`;
      const url =
        "https://itunes.apple.com/search"
        + "?term=" + encodeURIComponent(term)
        + "&media=music"
        + "&entity=song"
        + "&limit=1"
        + "&country=US";

      const response = await fetch(url);
      const data = await response.json();
      const results = data.results || [];

      if (results.length > 0 && results[0].artworkUrl100) {
        const albumArtUrl = results[0].artworkUrl100.replace('100x100bb', '300x300bb');

        await pool.query(
          `UPDATE songs SET album_art_url = ? WHERE id = ?`,
          [albumArtUrl, song.id]
        );

        console.log(`Updated: ${song.Title} - ${song.Artist}`);
      } else {
        console.log(`No art found: ${song.Title} - ${song.Artist}`);
      }
    } catch (err) {
      console.error(`Error for ${song.Title} - ${song.Artist}:`, err.message);
    }
  }

  await pool.end();
}

backfillAlbumArt();