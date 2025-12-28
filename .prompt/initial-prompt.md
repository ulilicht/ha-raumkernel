Help me to plan and build a homeassistant integration, based on an addon. The Addon should be called Homeassistant Raumkernel (ha-raumkernel-addon)

The purpose of the project is to control teufel raumfeld audio devices through homeassistant.

I therefore want to use the project git@github.com:ulilicht/node-raumkernel.git which is a nodejs project to control the speakers. You can examine the code which is cloned into this folder: ./.prompt/example-code/node-raumkernel.

I want to package this as a homeassistant addon and then from there build an integration for raumfeld on homeassistant. The project should contain a javascript based abstraction layer with which it is possible to combine method calls for node-raumkernel.

I have already setup a running homeassistant addon in the current working space (ha-raumkernel-addon), use this as a base.

For a first plan:

- Think about what are the minimum necessary commands which an integration for a media player in homeassistant needs to offer.
- What is the best repository and folder structure for the addon?
- The repo and folder structure should enable easy local testing of the addon and the integration in homeassistant, using devcontainers. The devcontainer is already setup and working for ha-raumkernel-addon.
- How can the APIs of the nodejs package be exposed from the addon?
- Keep the code close to the examples in homeassistant and the default so that it is easy to test
- Adjust the README.md and document steps for testing and running locally there.

Additional information:

- The folder .prompt documents important prompts for an AI code assistant. It as well contains example code to be studied by the AI code assistant. It does not need to be changed if not explicitly asked for it.
