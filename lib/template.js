import Handlebars from "handlebars";

function renderTemplate(template, variables) {
    const compiled = Handlebars.compile(template, {
        noEscape: true,   // allows URLs, line breaks, etc.
        strict: false     // missing variables won't throw
    });

    return compiled(variables);
}

export default renderTemplate;