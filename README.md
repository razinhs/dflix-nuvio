# DFLIX + CircleFTP for Nuvio

Watch DFLIX and CircleFTP movies and episodes from Nuvio's normal search and playback screen. Both providers run on your device and send the final stream directly to Nuvio's player.

You do not need a TMDB account, API key, plugin settings, or a computer running in the background.

## Install

You need a Nuvio build that supports plugins. The Google Play build does not, so use the Full/GitHub build.

1. Open **Nuvio**.
2. Go to **Settings → Plugins → Add Repository**.
3. Paste this URL:

```text
https://raw.githubusercontent.com/razinhs/dflix-nuvio/main/manifest.json
```

4. Add or refresh the repository.
5. Enable **DFLIX Cloud**, **CircleFTP**, or both.

If you installed an older DFLIX provider, disable or remove it first so you do not get duplicate results.

## Providers

### DFLIX Cloud

DFLIX results can include:

- every available file for the selected movie or episode;
- quality and file size;
- container and video codec;
- audio language when DFLIX provides it.

DFLIX exposes TMDB identity. The provider verifies the exact canonical TMDB ID before returning a stream, so a different title with the same name is rejected.

### CircleFTP

CircleFTP results can include:

- multiple exact movie variants, such as English and dual-audio copies;
- the requested season and episode from matching series;
- quality, container, and release/audio text supplied by CircleFTP.

CircleFTP's public player API does not expose TMDB or IMDb IDs. The provider therefore matches the canonical TMDB title (and original title when different), release year, and movie/series type. It validates those fields again on the detail response and rejects malformed, mismatched, non-video, or non-CircleFTP links. This is stricter than browsing CircleFTP's H5AI year folders, but it cannot provide the same ID-level certainty as DFLIX.

The provider uses CircleFTP's player API rather than recursively crawling `index.circleftp.net`, `index2.circleftp.net`, and the many numbered FTP hosts. It considers at most four exact candidates, returns at most 100 unique streams, performs detail requests sequentially for Nuvio's synchronous native fetch bridge, and only launches requests during a 25-second budget that reserves time under Nuvio's 60-second invocation limit.

## Privacy and network behavior

For both providers, the plugin sends the media type and TMDB or IMDb title ID supplied by Nuvio to the repository's fixed metadata service. It does not send account details or expose a TMDB API credential.

DFLIX then receives title searches and detail requests over HTTPS.

CircleFTP receives title searches and detail requests through its public API at `new.circleftp.net`. CircleFTP currently provides that API and its video files over unencrypted HTTP, so titles requested and stream URLs may be visible to the local network and ISP. The plugin only accepts direct video links under `*.circleftp.net/FILE/`; it does not act as an arbitrary URL fetcher.

This repository does not host or proxy video files. Playback goes directly from DFLIX or CircleFTP to Nuvio.

## If it does not work

- **Plugins are unavailable:** install the Full/GitHub version of Nuvio.
- **A provider does not appear:** refresh the repository and make sure that provider is enabled.
- **You see duplicate DFLIX results:** disable older DFLIX repositories or providers.
- **A specific title has no result:** it may not be available, its CircleFTP title/year may not match canonical metadata, or the source may be unavailable on your network.
- **CircleFTP fails outside your ISP:** CircleFTP is an ISP/private-network service and may not be reachable on other networks.

## TMDB notice

This product uses the TMDB API but is not endorsed or certified by TMDB.
