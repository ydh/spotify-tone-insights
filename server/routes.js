'use strict';

const Spotify = require('spotify-web-api-node');
const Promise = require('bluebird');
const express = require('express');
const watson = require('watson-developer-cloud');
const request = Promise.promisifyAll(require('request'));
const router = new express.Router();
const appEnv = require('./appEnv');
const cloudant = require('./cloudant');

let envVars = {};
try {
  envVars = require('./ENV_VARS.json');
} catch(e) {} // don't do anything, just means JSON file doesnt exist

// configure the spotify credentials
const CLIENT_ID = envVars.CLIENT_ID || process.env.CLIENT_ID;
const CLIENT_SECRET = envVars.CLIENT_SECRET || process.env.CLIENT_SECRET;
const REDIRECT_URI = envVars.REDIRECT_URI || process.env.REDIRECT_URI;
const MAX_OFFSET = 50;
const STATE_KEY = 'spotify_auth_state';
// your application requests authorization
const scopes = ['user-read-private', 'user-library-read', 'playlist-read-private'];

// configure watson
const toneCredentials = appEnv.getService(/tone analyzer/ig).credentials;
const toneAnalyzer = watson.tone_analyzer({
  username: toneCredentials.username,
  password: toneCredentials.password,
  version: 'v3-beta',
  version_date: '2016-02-11'
});

// configure spotify
const spotifyApi = new Spotify({
  clientId: CLIENT_ID,
  clientSecret: CLIENT_SECRET,
  redirectUri: REDIRECT_URI
});

// configure musixmatch
const MUSIXMATCH_URL = 'http://api.musixmatch.com/ws/1.1';
const MUSIXMATCH_KEY = envVars.MUSIXMATCH_KEY || process.env.MUSIXMATCH_KEY;

/** Generates a random string containing numbers and letters of N characters */
const generateRandomString = N => (Math.random().toString(36)+Array(N).join('0')).slice(2, N+2);

/**
 * The /login endpoint
 * Redirect the client to the spotify authorize url, but first set that user's
 * state in the cookie.
 */
router.get('/login', (_, res) => {
  const state = generateRandomString(16);
  res.cookie(STATE_KEY, state);
  res.redirect(spotifyApi.createAuthorizeURL(scopes, state));
});

/**
 * The /callback endpoint - hit after the user logs in to spotifyApi
 * Verify that the state we put in the cookie matches the state in the query
 * parameter. Then, if all is good, redirect the user to the user page. If all
 * is not good, redirect the user to an error page
 */
router.get('/callback', (req, res) => {
  const { code, state } = req.query;
  const storedState = req.cookies ? req.cookies[STATE_KEY] : null;
  // first do state validation
  if (state === null || state !== storedState) {
    res.redirect('/#/error/state mismatch');
  // if the state is valid, get the authorization code and pass it on to the client
  } else {
    res.clearCookie(STATE_KEY);
    // Retrieve an access token and a refresh token
    spotifyApi.authorizationCodeGrant(code).then(data => {
      const { expires_in, access_token, refresh_token } = data.body;

      // Set the access token on the API object to use it in later calls
      spotifyApi.setAccessToken(access_token);
      spotifyApi.setRefreshToken(refresh_token);

      // we can also pass the token to the browser to make requests from there
      res.redirect(`/#/user/${access_token}/${refresh_token}`);
    }).catch(err => {
      res.redirect('/#/error/invalid token');
    });
  }
});

/**
 * The tone endpoint
 */
router.get('/tone', (req, res) => {
  const { track, artist, album } = req.query;
  getLyrics(track, artist, album).then(lyrics => {
    return toneAsync(lyrics);
  }).then(tone => {
    res.json(tone);
  }).catch(e => {
    res.status(500);
    res.json(e);
    console.error(e);
    console.error(e.stack);
  });
});

// first see if lyrics are in cloudant, if they aren't get the song from
// musixmatch, and put the result in cloudant for some fun caching. returns
// a promise that resolves with the lyrics
function getLyrics(track, artist, album) {
  return cloudant.get(track, artist, album).then(body => {
    return body.lyrics;
  }, e => {
    if (e.error === 'not_found') {
      return matchSong(track, artist, album)
        .then(id => getLyricsFromMusixMatch(id))
        .then(lyrics => {
          cloudant.insert(track, artist, album, lyrics);
          return lyrics;
        });
    } else {
      throw e;
    }
  });
}

// get a track id from a song
function matchSong(track, artist, album) {
  return request.getAsync({
    url: `${MUSIXMATCH_URL}/matcher.track.get`,
    json: true,
    qs: {
      apikey: MUSIXMATCH_KEY,
      q_track: track,
      q_artist: artist,
      q_album: album,
      f_has_lyrics: 1
    }
  }).then(response => response.body.message.body.track.track_id);
}

// get song lyrics from a track id
function getLyricsFromMusixMatch(track_id) {
  return request.getAsync({
    url: `${MUSIXMATCH_URL}/track.lyrics.get`,
    json: true,
    qs: {
      apikey: MUSIXMATCH_KEY,
      track_id
    }
  }).then(response => cleanLyrics(response.body.message.body.lyrics.lyrics_body));
}

// strip legal stuff from lyrics and pad \ns with spaces so watson tone can read them
function cleanLyrics(lyrics) {
  const COPYRIGHT = '******* This Lyrics is NOT for Commercial use *******';
  const cIndex = lyrics.indexOf(COPYRIGHT);
  return lyrics.substring(0, cIndex).replace(/\n/g, ' \n ');
}

// promise-based tone analysis
function toneAsync(text) {
  return new Promise((resolve, reject) => {
    toneAnalyzer.tone({ text }, (e, tone) => {
      if (e) {
        reject(e);
      } else {
        resolve(tone);
      }
    });
  });
}

module.exports = router;
