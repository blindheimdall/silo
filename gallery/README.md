# The SILO gallery

Procedures that SILOs share. They are listed in the last chapter of the Order, and adopted in one step. Every SILO reads `index.json` from this folder on GitHub when someone opens the Order, and ships with a copy of it.

## Add a procedure

1. In SILO, open the workflow, select **Share** and save the file.
2. Put it in this folder with a short name of lower-case letters, digits and dashes, for example `customer-reply.silo.json`.
3. Run `node tools/gallery.mjs`. It adds the procedure to `index.json` with the fingerprint (SHA-256) of the file.
4. In `index.json`, write your name as `author` and up to six `tags`, then run `node tools/gallery.mjs` again.
5. Run `npm test` and open a pull request. The tests check that the index matches the files and that every procedure can be adopted.

Read the file before you send it: the brief, the app steps and the tests may hold private text. A procedure never starts on its own and gives no resident a new permission where it is adopted.

## A catalog of your own

Make a folder with procedure files, run `node tools/gallery.mjs --dir <that folder>`, and serve the folder over https. In SILO, an owner sets its `index.json` address under the gallery chapter, or with `SILO_GALLERY_FEED` before the first start. See "The gallery" in [the handbook](../docs/handbook.md).
