# https://developers.home-assistant.io/docs/add-ons/configuration#add-on-dockerfile
ARG BUILD_FROM
FROM $BUILD_FROM

# Execute during the build of the image
ARG TEMPIO_VERSION BUILD_ARCH
RUN \
    curl -sSLf -o /usr/bin/tempio \
    "https://github.com/home-assistant/tempio/releases/download/${TEMPIO_VERSION}/tempio_${BUILD_ARCH}" && \
    apk add --no-cache \
    nodejs \
    npm \
    git \
    openssh-client

# Copy root filesystem
COPY rootfs /

# Copy integration for auto-install
# NOTE: teufel_raumfeld_raumkernel is a copy of custom_components/teufel_raumfeld_raumkernel
# Do not edit files in teufel_raumfeld_raumkernel directly - edit the source in custom_components/
COPY teufel_raumfeld_raumkernel /integration

WORKDIR /app


RUN npm install && \
    mkdir -p lib && \
    cp node_modules/node-raumkernel/lib/setUriMetadata.template lib/

