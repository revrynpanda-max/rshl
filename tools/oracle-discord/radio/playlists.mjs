/**
 * playlists.mjs — Ryan's predefined radio playlists
 * Add/remove songs here. Leo pulls from these when in playlist mode.
 */

export const PLAYLISTS = {
  'default': [
    { title: 'Blinding Lights', artist: 'The Weeknd' },
    { title: 'Levitating', artist: 'Dua Lipa' },
    { title: 'Stay', artist: 'The Kid LAROI Justin Bieber' },
    { title: 'Peaches', artist: 'Justin Bieber' },
    { title: 'Good 4 U', artist: 'Olivia Rodrigo' },
    { title: 'Montero', artist: 'Lil Nas X' },
    { title: 'Save Your Tears', artist: 'The Weeknd' },
    { title: 'Industry Baby', artist: 'Lil Nas X Jack Harlow' },
    { title: 'Heat Waves', artist: 'Glass Animals' },
    { title: 'As It Was', artist: 'Harry Styles' },
  ],
  'late-night': [
    { title: 'Nights', artist: 'Frank Ocean' },
    { title: 'Ivy', artist: 'Frank Ocean' },
    { title: 'Redbone', artist: 'Childish Gambino' },
    { title: 'Lost', artist: 'Frank Ocean' },
    { title: 'Self Control', artist: 'Frank Ocean' },
    { title: 'Pink + White', artist: 'Frank Ocean' },
    { title: 'Solo', artist: 'Frank Ocean' },
    { title: 'Novacane', artist: 'Frank Ocean' },
    { title: 'Swim Good', artist: 'Frank Ocean' },
    { title: 'Chanel', artist: 'Frank Ocean' },
  ],
  'hype': [
    { title: 'HUMBLE', artist: 'Kendrick Lamar' },
    { title: 'God Did', artist: 'DJ Khaled'},
    { title: 'Rich Flex', artist: 'Drake 21 Savage' },
    { title: 'Knife Talk', artist: 'Drake' },
    { title: 'Way 2 Sexy', artist: 'Drake' },
    { title: 'SICKO MODE', artist: 'Travis Scott' },
    { title: 'Rockstar', artist: 'Post Malone' },
    { title: 'Congratulations', artist: 'Post Malone' },
    { title: 'Lucid Dreams', artist: 'Juice WRLD' },
    { title: 'Legends Never Die', artist: 'Juice WRLD' },
  ],
  'chill': [
    { title: 'location', artist: 'Khalid' },
    { title: 'Young Dumb Broke', artist: 'Khalid' },
    { title: 'Talk', artist: 'Khalid' },
    { title: 'Better', artist: 'Khalid' },
    { title: 'Motion', artist: 'Drake' },
    { title: 'Passionfruit', artist: 'Drake' },
    { title: 'Jorja Interlude', artist: 'Drake' },
    { title: 'Get It Together', artist: 'Drake' },
    { title: 'From Time', artist: 'Drake' },
    { title: 'Doing It Wrong', artist: 'Drake' },
  ]
};

export function getPlaylist(name) {
  const key = (name || 'default').toLowerCase();
  return PLAYLISTS[key] || PLAYLISTS['default'];
}

export function getPlaylistNames() {
  return Object.keys(PLAYLISTS);
}
