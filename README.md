# DFLIX for Nuvio

Watch DFLIX movies and episodes from the normal Nuvio search and playback screen. The provider runs on your device and sends the final stream straight to Nuvio's player.

You do not need a TMDB account, API key, plugin settings, or a computer running in the background.

To identify the right title, the provider sends only the media type and numeric TMDB ID to its metadata service. It does not send account details or an API key.

## Install

You need a Nuvio build that supports plugins. The Google Play build does not, so use the Full/GitHub build.

1. Open **Nuvio**.
2. Go to **Settings → Plugins → Add Repository**.
3. Paste this URL:

```text
https://raw.githubusercontent.com/razinhs/dflix-nuvio/main/manifest.json
```

4. Add the repository and enable **DFLIX Cloud**.

If you installed an older DFLIX provider, disable or remove it first so you do not get duplicate results.

## What it shows

DFLIX appears with your other playback providers. Results can include:

- every available file for the selected movie or episode;
- quality and file size;
- container and video codec;
- audio language when DFLIX provides it.

The provider checks the exact TMDB ID before returning a stream. If DFLIX has a different movie with the same name, it will not be accepted by mistake.

## If it does not work

- **Plugins are unavailable:** install the Full/GitHub version of Nuvio.
- **DFLIX does not appear:** make sure the repository and DFLIX Cloud provider are enabled.
- **You see duplicate DFLIX results:** disable older DFLIX repositories or providers.
- **A specific title has no result:** it may not be available on DFLIX, or DFLIX may be temporarily unavailable on your network.

DFLIX access depends on your ISP and network. This repository does not host or proxy any video files.

## TMDB notice

This product uses the TMDB API but is not endorsed or certified by TMDB.
