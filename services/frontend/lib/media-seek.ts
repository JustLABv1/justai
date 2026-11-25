type FrameCallbackVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (callback: () => void) => number
  cancelVideoFrameCallback?: (handle: number) => void
}

const pendingSeeks = new WeakMap<HTMLMediaElement, object>()

/** How long the picture may stand still after a seek while audio plays. */
const frozenPictureTimeoutMs = 1500

/**
 * Seek a media element reliably and optionally start playback.
 *
 * Browsers (Safari in particular) ignore `currentTime` until metadata has
 * loaded, so a jump requested before that silently does nothing. For long
 * videos Safari can also leave the picture frozen after a seek while the
 * audio keeps playing. The seek is therefore applied once metadata exists,
 * and a video whose picture does not advance after the seek is re-seeked to
 * its current position, which restarts the video decoder.
 *
 * `play()` is called synchronously so it stays inside the user gesture.
 */
export function seekMedia(
  media: HTMLMediaElement,
  offsetMs: number,
  play: boolean
): Promise<void> {
  const target = Math.max(0, offsetMs) / 1000
  const token = {}
  pendingSeeks.set(media, token)
  const apply = () => {
    if (pendingSeeks.get(media) !== token) return
    media.currentTime = target
    if (media instanceof HTMLVideoElement)
      watchFrozenPicture(media, token, target)
  }
  if (media.readyState >= HTMLMediaElement.HAVE_METADATA) {
    apply()
  } else {
    media.addEventListener("loadedmetadata", apply, { once: true })
    if (media.networkState === HTMLMediaElement.NETWORK_EMPTY) media.load()
  }
  return play ? media.play() : Promise.resolve()
}

function watchFrozenPicture(
  video: FrameCallbackVideo,
  token: object,
  target: number
) {
  const request = video.requestVideoFrameCallback?.bind(video)
  if (!request) return
  const onSeeked = () => {
    if (pendingSeeks.get(video) !== token) return
    let presented = false
    const handle = request(() => {
      presented = true
    })
    window.setTimeout(() => {
      if (presented || pendingSeeks.get(video) !== token) return
      video.cancelVideoFrameCallback?.(handle)
      // Time (and audio) advanced but no new picture arrived: nudge the
      // decoder. While buffering, time does not advance and nothing happens.
      if (
        !video.paused &&
        !video.seeking &&
        video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA &&
        video.currentTime > target + 0.5
      ) {
        video.currentTime = video.currentTime
      }
    }, frozenPictureTimeoutMs)
  }
  video.addEventListener("seeked", onSeeked, { once: true })
}
