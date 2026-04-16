import 'dotenv/config';
import express from 'express';
import mysql from 'mysql2/promise';
import session from 'express-session';

const app = express();
app.set('view engine', 'ejs');
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));

app.use(
    session({
        secret: process.env.SESSION_SECRET || 'dev-secret-change-me',  // TODO: move to env var in prod
        resave: false,
        saveUninitialized: false,
        cookie: { maxAge: 1000 * 60 * 60 * 8 }, // 8h
    })
);

// make `user` available in all EJS views as res.locals.user
app.use((req, res, next) => {
    res.locals.user = req.session.user || null;
    next();
});

const isLoggedIn = (req, res, next) => {
    if (!req.session.user) {
        return res.redirect('/auth/login');
    }
    next();
};

//log into PHP to see database with these credentials
const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT || 3306,
    connectionLimit: 10,
    waitForConnections: true
});

//=============================== HOME ROUTE =============================
app.get('/', async (req, res) => {
  let heroSong = null;  
  let myReviews = [];
  let friendsFeed = [];

  try {
    if (req.session.user) {
      const userId = req.session.user.id;

      // ===== Your own reviews (for Delete Song modal) =====
      const sqlMyReviews = `
        SELECT reviews.id AS reviewId, songs.Title, songs.Artist
        FROM reviews
        JOIN songs ON reviews.Song_id = songs.id
        WHERE reviews.User_id = ?
      `;
      const [myRows] = await pool.query(sqlMyReviews, [userId]);
      myReviews = myRows;

      // ===== Friends' recent reviews feed =====
      const sqlFriendsFeed = `
        SELECT 
          r.id            AS reviewId,
          s.Title         AS songTitle,
          s.Artist        AS artist,
          s.Genre         AS genre,
          s.Album_art_url AS albumArt,
          r.Rating        AS rating,
          r.Comment       AS comment,
          r.Date_reviewed AS dateReviewed,
          u.username      AS friendUsername
        FROM reviews r
        JOIN songs   s ON r.Song_id = s.id
        JOIN users   u ON r.User_id = u.id
        JOIN follows f ON f.followed_id = r.User_id
        WHERE f.follower_id = ?
        ORDER BY r.Date_reviewed DESC
        LIMIT 20
      `;

      const [feedRows] = await pool.query(sqlFriendsFeed, [userId]);

      // Format rows into the shape home.ejs expects
      friendsFeed = [];

      for (let i = 0; i < feedRows.length; i++) {
        const row = feedRows[i];

        // Make sure we have a Date object
        let reviewedDate;
        if (row.dateReviewed instanceof Date) {
          reviewedDate = row.dateReviewed;
        } else {
          reviewedDate = new Date(row.dateReviewed);
        }

        // Format the time values
        let createdISO = reviewedDate.toISOString();
        let createdHuman = reviewedDate.toLocaleString('en-US', {
          dateStyle: 'medium',
          timeStyle: 'short'
        });

        const formattedReview = {
          reviewId:       row.reviewId,
          songTitle:      row.songTitle,
          artist:         row.artist,
          genre:          row.genre,
          albumArt:       row.albumArt,
          rating:         row.rating,
          comment:        row.comment,
          friendUsername: row.friendUsername,
          createdISO:     createdISO,
          createdHuman:   createdHuman
        };

        friendsFeed.push(formattedReview);
      }
    }

    // ===== Random hero song for logged-out users =====
    if (!req.session.user) {
    const sqlHeroSong = `
        SELECT 
        Title AS title,
        Artist AS artist,
        Genre AS genre,
        Album_art_url AS albumArt
        FROM songs
        WHERE Album_art_url IS NOT NULL
        ORDER BY RAND()
        LIMIT 1
    `;

    const [heroRows] = await pool.query(sqlHeroSong);

    if (heroRows.length > 0) {
        heroSong = heroRows[0];
    }
    }

    res.render('home.ejs', {
      friendsFeed: friendsFeed,
      myReviews: myReviews,
      heroSong: heroSong,
      error: null
    });

  } catch (err) {
    console.error("Error loading home page: ", err);
    res.status(500).render('home.ejs', {
      friendsFeed: [],
      myReviews: [],
      heroSong: null,
      error: 'Error loading your home feed. Please try again.'
    });
  }
});

//================================= LOG IN PAGE ===========================================
app.get('/auth/login', (req, res) => {
    res.render('login.ejs')
});

app.post('/auth/login', async (req, res) => {
    const { username, password } = req.body;
    let sql = `SELECT id, username, date_joined 
               FROM users 
               WHERE username = ? AND password = ? 
               LIMIT 1`;
    const [rows] = await pool.query(sql, [username, password]);

    if (rows.length === 1) {
        req.session.user = rows[0]; //id, username, date_joined
        //console.log(rows[0]);
        return res.redirect('/');
    }

    //if failed
    res.status(401).render('login.ejs', { error: 'Invalid Credentials' });
})

//----- for Logout button ------
app.post('/auth/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/'));
})

//================================= SIGN UP PAGE ========================================
app.get('/auth/signup', (req, res) => {
    res.render('signup.ejs')
});

app.post('/auth/signup', async(req, res) => {
    const {username, password, confirmPass} = req.body;
    const FIRST_FRIEND = 1;

    //check all fields filled
    if (!username || !password || !confirmPass) {
        return res.status(400).render('signup.ejs', { error: 'All fields are required.' });
    }

    //check pass and confirmPass match
    if (password != confirmPass) {
        return res.status(400).render('signup.ejs', { error: 'Passwords do not match.' });
    }

    if (password.length < 6) {
        return res.status(400).render('signup.ejs', { error: 'Password must be at least 6 characters.' });
    }

    //check if username is available
    let sql = `SELECT id FROM users WHERE username = ?`;
    const [exists] = await pool.query(sql, [username]);
    if (exists.length) { //if there is a length to exists that means it exists
        return res.status(409).render('signup.ejs', { error: 'Username is already taken.' });
    }

    let insert = `INSERT INTO users (username, password, date_joined) VALUES (?, ?, NOW())`;
    const [result] = await pool.query(insert, [username, password]);
    const newUserId = result.insertId;

    //auto friend w/ lesly
    let sqlFriend = `INSERT INTO follows (follower_id, followed_id, created_at) VALUES (?, ?, NOW())`;
    const[friend] = await pool.query(sqlFriend, [newUserId, FIRST_FRIEND]);
    
    let sqlFriendBack = `INSERT INTO follows (follower_id, followed_id, created_at) VALUES (?,?, NOW())`;
    const[friendBack] = await pool.query(sqlFriendBack, [FIRST_FRIEND, newUserId]);

    //automatically log in after sign up
    req.session.user = {id: newUserId, username};
    return res.redirect('/');
});

app.post('/reviews', isLoggedIn, async (req, res) => {
    const { title, artist, genre, rating, comment } = req.body;
    const userId = req.session.user.id;

    if (!title || !artist || !rating) {
        return res.status(400).render('home.ejs', {
            error: 'Title, Artist, and Rating need to be filled in.', friendsFeed: [], myReviews: []
        });
    }

    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();

        //try to get album art from itunes API
        let albumArtUrl = null;

        try{
            const term = `${title} ${artist}`;
            const url = "https://itunes.apple.com/search"
                        + "?term=" + encodeURIComponent(term)
                        + "&media=music"
                        + "&entity=song"
                        + "&limit=1"
                        + "&country=US";
            
            const response = await fetch(url);
            const data = await response.json();
            const results = data.results || [];
            
            if(results.length > 0 && results[0].artworkUrl100){
                //might use a bigger size later
                albumArtUrl = results[0].artworkUrl100.replace('100x100bb', '300x300bb');
            }
        } catch (apiErr) {
            console.error('Error fetching album art from iTunes:', apiErr);
        }

        //find or create song
        let [existingSong] = await conn.query('SELECT id FROM songs WHERE Title = ? AND Artist = ? LIMIT 1', [title, artist]);
        let songId;

        if (existingSong.length === 0) {
            const [songInsert] = await conn.query('INSERT INTO songs (Title, Artist, Genre, album_art_url, created_by) VALUES (?, ?, ?, ?, ?)', [title, artist, genre || null, albumArtUrl, userId]);
            songId = songInsert.insertId;
        }
        else {
            songId = existingSong[0].id;

            if (!existingSong[0].album_art_url  && albumArtUrl) {
                await conn.query(
                    `UPDATE songs SET album_art_url = ? WHERE id = ?`,
                    [albumArtUrl, songId]
                );
            }
        }

        await conn.query('INSERT INTO reviews (User_id, Song_id, Rating, Comment, Date_reviewed) VALUES (?, ?, ?, ?, NOW())', [userId, songId, rating, comment || null]);
        await conn.commit();
        conn.release();
        res.redirect('/');
    }
    catch (err) {
        await conn.rollback();
        console.error("Error adding song or review:", err);
        res.status(500).render('home.ejs', {
            error: 'An error occurred. Try again!',
            friendsFeed: [],
            myReviews: []        // used to be `discover: []`
        });
    }
});

app.post('/reviews/delete', isLoggedIn, async (req, res) => {
    const { reviewId } = req.body;
    if (!reviewId) {
        return res.redirect('/');
    }

    try {
        await pool.query('DELETE FROM reviews WHERE id = ? AND User_id = ?',
        [reviewId, req.session.user.id]);
        res.redirect('/');
    }
    catch (err) {
        console.error("Error deleting review:", err);
        res.status(500).send("Error deleting review");
    }
});

app.post('/reviews/update', isLoggedIn, async (req, res) => {
    const { reviewId, songId, rating, comment, genre } = req.body;
    const userId = req.session.user.id;

    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();

        await conn.query(`UPDATE reviews SET Rating = ?, Comment = ?, Date_reviewed = NOW() WHERE id = ? AND User_id = ?`,
            [rating, comment, reviewId, userId]);

        if (genre && songId) {
            await conn.query(
                `UPDATE songs SET Genre = ? WHERE id = ?`,
                [genre, songId]
            );
        }
        await conn.commit();
        res.redirect('/library');
    } 
    catch (err) {
        await conn.rollback();
        console.error("Error updating review:", err);
        res.status(500).send("Error updating review");
    }
});

app.get('/lyrics', async(req, res) => {
    let artist = req.query.artist;
    let title = req.query.title;

    if(!artist || !title){
        return res.render('lyrics.ejs',{
            artist:"",
            title:"",
            lyrics:null,
            error:null
        });
    }
    try{
        let url = `https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(title)}`;
        let response = await fetch(url);

        if (!response.ok) {
            throw new Error(`API returned status: ${response.status}`);
        }
        let data = await response.json();

        // This would only run if the lyrics aren't found
        if(!data.lyrics){
            return res.render('lyrics.ejs',{
                artist,
                title,
                lyrics:null,
                error:"Lyrics not found."
            });
        }

        // Successfully runs
        return res.render('lyrics.ejs',{
            artist,
            title,
            lyrics:data.lyrics,
            error:null
        });

    }catch(err){
        console.error("Lyrics API Error:",err);

        return res.render('lyrics.ejs',{
            artist,
            title,
            lyrics:null,
            error:"Error getting lyrics"
        });
    }
   // res.render('library.ejs')
});

app.get('/searching', async (req, res) => {
    let term = (req.query.q || "").trim();

    if (!term) {
        return res.render('searching.ejs', {
            term: "",
            results: [],
            error: null
        });
    }

    try {
        let url =
            "https://itunes.apple.com/search"
            + "?term=" + encodeURIComponent(term)
            + "&media=music"
            + "&entity=song"
            + "&limit=20"
            + "&country=US";
        let response = await fetch(url);
        let data = await response.json();

        let results = data.results || [];

        return res.render('searching.ejs', {
            term,
            results,
            error: results.length ? null : "No songs found"
        });
    } catch (err) {
        console.error("iTunes search error:", err);

        return res.render('searching.ejs', {
            term,
            results: [],
            error: "Error getting search results from iTunes"
        });
    }
});

app.get('/track/:artist/:title', async(req, res) => {
    let artist = req.params.artist;
    let title = req.params.title;

    try{
        let itunesUrl = 
        "https://itunes.apple.com/search"
            + "?term=" + encodeURIComponent(artist + " " + title)
            + "&media=music"
            + "&entity=song"
            + "&limit=1";

    let itunesRes = await fetch(itunesUrl);
    let itunesData = await itunesRes.json();

    let track = itunesData.results[0] || null;

    let lastfmUrl =
         "https://ws.audioscrobbler.com/2.0/"
         + "?method=track.getInfo"
         + "&artist=" + encodeURIComponent(artist)
         + "&track=" + encodeURIComponent(title)
         + "&api_key=" + process.env.LASTFM_API_KEY
         + "&format=json";

         let lastfmRes = await fetch(lastfmUrl);
         let lastfmData = await lastfmRes.json();

         let lastfm = lastfmData.track || null;

         return res.render('track.ejs',{
            artist,
            title,
            track,
            lastfm,
            error:null

         });

        
    } catch (err){
        console.error("Track details error:", err);

        return res.render('track.ejs',{
            artist,
            title,
            track:null,
            lastfm:null,
            error:"Error getting track details"
        });

    }

});

app.get('/library', async (req, res) => {

    if(!req.session.user){
        return res.redirect('/auth/login');
    }

    let sql = `SELECT *
               FROM reviews
               JOIN songs ON reviews.song_id = songs.id 
               WHERE user_id LIKE ?`;
    let sqlParams = req.session.user.id;
    const [rows] = await pool.query(sql, [sqlParams]);
    //console.log(rows);
    res.render('library.ejs', { rows })
});

app.get('/profile', async (req, res) => {
    if(!req.session.user){
        return res.redirect('/auth/login');
    }

    //coopy session user so we can safely modify it
    const user = { ...req.session.user };

    //format date_joined
    if(user.date_joined){
        let d = (user.date_joined instanceof Date) 
        ? user.date_joined : new Date(user.date_joined);

        user.dateJoinedHuman = d.toLocaleString('en-US', {
            dateStyle: 'medium',
            timeStyle: 'short'
        });
    }
    res.render('profile.ejs', {user})
});

app.post('/changePassword', async (req, res) => {
    const {cPassword, nPassword} = req.body;
    const userId = req.session.user.id;
    console.log("check1");

    let getPassword = `SELECT password 
                       FROM users 
                       WHERE id = ?`
    const [password] = await pool.query(getPassword, [userId]);
    console.log("check1", password[0].password);
    
    if (password[0].password !== cPassword){
        return res.status(400).render('profile.ejs', { error: 'Current password is incorrect.' });
    }
    
    if (nPassword.length < 6){
        return res.status(400).render('profile.ejs', { error: 'Password must be at least 6 characters.' });
    }

    const sql = 'UPDATE users SET password = ? WHERE id = ?';

    await pool.query(sql,[nPassword, userId]);

    req.session.destroy(() => {
        res.redirect('/');
    });
});

// for delete account
app.post('/deleteAccount', async (req, res) => {
    const userId = req.session.user.id; // logged-in user's ID

    try {
        await pool.query('DELETE FROM reviews WHERE user_id = ?', [userId]);
        await pool.query('DELETE FROM users WHERE id = ?', [userId]);

        req.session.destroy(() => res.redirect('/'));
    } catch (err) {
        console.log(err);
        return res.status(500).render('profile.ejs', { 
            error: 'An error occurred while deleting your account.' 
        });
    }
});


app.get('/discover', async (req, res) => {
    const genres = ['Pop', 'Rock', 'Metal', 'Rap', 'Electronic', 'Country', 'R&B', 'Jazz'];
    const fetchGenre = async (genre) => {
        try {
            const url = "https://itunes.apple.com/search"
            + "?term=" + encodeURIComponent(genre)
            + "&media=music"
            + "&entity=song"
            + "&limit=50"
            + "&country=US";
            const response = await fetch(url);
            const data = await response.json();
            let songs = data.results || [];

            for (let i = songs.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [songs[i], songs[j]] = [songs[j], songs[i]];
            }
            return {
                genre: genre,
                songs: songs.slice(0, 10)
            };
        } catch (err) {
            console.error(`Error fetching ${genre}:`, err);
            return { genre: genre, songs: [] };
        }
    };

    const discoverData = await Promise.all(genres.map(fetchGenre));
    res.render('discover.ejs', {
        discoverData,
        user: req.session.user || null
    });
});

//===========================FOLLOWS PAGE==================================
app.get('/follows', async(req, res) => {
    //if user not logged in and tries to access follows page
    if(!req.session.user){
        return res.redirect('/auth/login');
    }

    const userId = req.session.user.id;
    const searchTerm = (req.query.q || '').trim();

    try{
        //people you follow
        let sql = `SELECT u.id, u.username, f.created_at
                    FROM follows f
                    JOIN users u ON u.id = f.followed_id
                    WHERE f.follower_id = ?
                    ORDER BY u.username`;
        const[following] = await pool.query(sql, [userId]);

        //format dates for following
        for (let i=0; i< following.length; i++){
            const row = following[i];
            let d;
            if(row.created_at instanceof Date){
                d= row.created_at;
            } else {
                d = new Date(row.created_at);
            }

            row.createdISO = d.toISOString();
            row.createdHuman = d.toLocaleString('en-US', {
                dateStyle: 'medium',
                timeStyle: 'short'
            });
        }

        //people who follow YOU and whether you follow them back
        let sql2 = `SELECT u.id, u.username, f.created_at,
                    EXISTS(
                        SELECT 1
                        FROM follows f2
                        WHERE f2.follower_id = ? AND f2.followed_id = u.id
                        ) AS you_follow_them
                    FROM follows f
                    JOIN users u ON u.id = f.follower_id
                    WHERE f.followed_id = ?
                    ORDER BY u.username`;
        const[followers] = await pool.query(sql2, [userId, userId]);

        // ---- Format dates for followers ----
        for (let i = 0; i < followers.length; i++) {
        const row = followers[i];

        let d;
        if (row.created_at instanceof Date) {
            d = row.created_at;
        } else {
            d = new Date(row.created_at);
        }

        row.createdISO = d.toISOString();
        row.createdHuman = d.toLocaleString('en-US', {
            dateStyle: 'medium',
            timeStyle: 'short'
        });
        }

        //search results
        let searchResults = [];
        if(searchTerm){
            let sqlFindUser = `SELECT u.id, u.username,
                                EXISTS(
                                    SELECT 1
                                    FROM follows f
                                    WHERE f.follower_id = ? AND f.followed_id = u.id
                                ) AS you_already_follow
                                FROM users u
                                WHERE u.username LIKE ? AND u.id != ?
                                ORDER BY u.username
                                LIMIT 20`;
            
            const[rows] = await pool.query(sqlFindUser, [userId, `%${searchTerm}%`, userId]);
            searchResults = rows;
        }

        res.render('follows.ejs', {following, followers, searchResults, searchTerm});
    } catch (err) {
        console.error('Error loading follows page: ', err);
        res.status(500).send('Error loading follows page');
    }

});

//===========================FOLLOW SOMEONE ROUTE==========================
app.post('/follows/add', async(req, res) => {
    if(!req.session.user){
        return res.redirect('/auth/login');
    }

    const userId = req.session.user.id;
    const {targetId} = req.body;

    if(!targetId || Number(targetId) === Number(userId)) {
        return res.redirect('/follows');
    }

    try {
        let sql = `INSERT IGNORE INTO follows (follower_id, followed_id, created_at)
        VALUES (?, ?, NOW())`;

        const[add] = await pool.query(sql, [userId, targetId]);
        res.redirect('/follows');
    } catch (err) {
        console.error('Error following user: ', err);
        res.status(500).send('Error following user');
    }
});

//========================UNFOLLOW SOMEONE================================
app.post('/follows/remove', async(req, res) => {
    if(!req.session.user) {
        return res.redirect('/auth/login');
    }

    const userId = req.session.user.id;
    const {targetId} = req.body;

    if(!targetId || Number(targetId) === Number(userId)) {
        return res.redirect('/follows');
    }

    try {
        let sql = `DELETE FROM follows
                    WHERE follower_id = ? AND followed_id = ?`;
        const[remove] = await pool.query(sql, [userId, targetId]);

        res.redirect('/follows');
    } catch (err) {
        console.error('Error unfollowing user: ', err);
        res.status(500).send('Error unfollowing user');

    }

});

app.listen(process.env.PORT || 3000, () => {
    console.log("Express server running");
});