/** Every field of the stored video value a site needs, to interpolate inside a projection:
 *  `"video": video{ ${VIDEO_PROJECTION} }`. */
export const VIDEO_PROJECTION =
  "renditions[]{ quality, url, poster }, placeholder, dimensions{ width, height }, playback{ autoplay, muted, loop, controls }";
