# The android flavour (#89): built FROM core, adding one driver family: the
# android emulator, its sdk tools, and the preboot check that names what the
# host must provide before anything boots. It reinstalls nothing the base
# already has: every system package and every file the base ships stays
# exactly as the base built it, which the CI check (images/check-derived.sh)
# enforces.
#
# The base is an ARG, so a build pins it (docs/images.md):
#   docker build --build-arg QARE_IMAGE=ghcr.io/vividynamics/qare-core@sha256:dde359505efbdc6336f776f068b5805c7164fd593083c4850ed1f5f83dfc67ef .
ARG QARE_IMAGE=ghcr.io/vividynamics/qare-core@sha256:dde359505efbdc6336f776f068b5805c7164fd593083c4850ed1f5f83dfc67ef

FROM $QARE_IMAGE

# The pinned sdk: the command line tools' build number, the api level and the
# system image variant are the pins; the tools the sdk manager installs at
# their latest are stamped with the versions actually downloaded, so the
# image's record always names what it ships. The emulator needs hardware
# virtualisation from the host and a 64 bit x86 system image, which is why
# this flavour is published for linux/amd64 only.
ARG CMDLINE_TOOLS_VERSION=11076708
ARG ANDROID_API_LEVEL=34
ARG ANDROID_SYSTEM_IMAGE=system-images;android-34;google_apis_playstore;x86_64
ARG IMAGE_NAME=qare-android

LABEL org.opencontainers.image.title=$IMAGE_NAME \
      org.opencontainers.image.description="QARE android: the core image plus the android emulator driver family" \
      org.opencontainers.image.source=https://github.com/ViviDynamics/qare

ENV ANDROID_HOME=/opt/qare/drivers/android/sdk
ENV ANDROID_AVD_HOME=/opt/qare/drivers/android/avd

# The sdk tools need java to run, the emulator does not: java is installed
# for the sdk manager and dropped again, so the image ships only what the
# driver family runs. The emulator's library needs are installed beside it.
# The downloader is the base's own python, not a new package: the flavour
# installs nothing the base already provides a tool for.
USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends openjdk-17-jdk-headless libgl1 libpulse0 libnss3 libasound2 \
 && rm -rf /var/lib/apt/lists* \
 && python3 -c "import urllib.request; urllib.request.urlretrieve('https://dl.google.com/android/repository/commandlinetools-linux-${CMDLINE_TOOLS_VERSION}_latest.zip', '/tmp/cmdline-tools.zip')" \
 && mkdir -p "$ANDROID_HOME/cmdline-tools" \
 && python3 -m zipfile -e /tmp/cmdline-tools.zip /tmp/cmdline-tools \
 && mv /tmp/cmdline-tools/cmdline-tools "$ANDROID_HOME/cmdline-tools/latest" \
 && chmod -R +x "$ANDROID_HOME/cmdline-tools/latest/bin" \
 && rm /tmp/cmdline-tools.zip \
 && yes | "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" --licenses > /dev/null \
 && "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" "platform-tools" "emulator" "$ANDROID_SYSTEM_IMAGE" > /dev/null \
 && mkdir -p "$ANDROID_AVD_HOME" \
 && echo no | "$ANDROID_HOME/cmdline-tools/latest/bin/avdmanager" create avd --name qare --package "$ANDROID_SYSTEM_IMAGE" --device pixel \
 && chown -R qare:qare /opt/qare/drivers/android \
 && apt-get purge -y openjdk-17-jdk-headless \
 && rm -rf /var/lib/apt/lists*

# The driver family's own record, beside its sdk: what the evidence reads
# when a run reports the driver versions that produced it. The emulator and
# adb versions are stamped from the tools themselves, not guessed.
RUN EMULATOR_VERSION="$("$ANDROID_HOME/emulator/emulator" --version 2>&1 | head -n 1)" \
 && ADB_VERSION="$("$ANDROID_HOME/platform-tools/adb" --version | head -n 1)" \
 && mkdir -p /opt/qare/drivers/android \
 && node -e "process.stdout.write(JSON.stringify({ name: 'android', drivers: { cmdlineTools: '$CMDLINE_TOOLS_VERSION', api: '$ANDROID_API_LEVEL', systemImage: '$ANDROID_SYSTEM_IMAGE', emulator: '$EMULATOR_VERSION', adb: '$ADB_VERSION' }, display: 'emulator' }))" \
      > /opt/qare/drivers/android/DRIVER.json \
 && chown qare:qare /opt/qare/drivers/android/DRIVER.json

COPY images/android/check /opt/qare/drivers/android/check
RUN chmod 755 /opt/qare/drivers/android/check \
 && chown qare:qare /opt/qare/drivers/android/check

# The flavour's name reaches the run's evidence: the image sets it, and the
# runner hands the image's ref and digest through the environment beside it.
ENV QARE_FLAVOUR=android
ENV QARE_DRIVER_VERSIONS=api=$ANDROID_API_LEVEL

# The contract's user again: the base's USER stands, but a build that ran as
# root above must end as the image runs, as the qare user.
USER qare
WORKDIR /work
