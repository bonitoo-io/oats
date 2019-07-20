import { camelize } from "humps"

import { PathOperation, Operation } from "./types"
import { STATUSES } from "./statuses"

export function formatTypeField(
  readOnly: boolean,
  name: string,
  required: boolean,
  type: string,
  description?: string
) {
  return `${readOnly ? "readonly " : ""}${name}${required ? "" : "?"}: ${type};`
}

export function isTypeNamed(type: string): boolean {
  if (type.startsWith("interface")) {
    return false
  }

  const code = type.charCodeAt(0)

  // Assume that if a type starts with an alphabetical character, then it is a
  // named type
  return (code > 64 && code < 91) || (code > 96 && code < 123)
}

export function formatTypeDeclaration(name: string, impl: string): string {
  if (!impl.startsWith("{")) {
    return `type ${name} = ${impl}`
  }

  let bracesCount = 0

  for (const c of impl) {
    if (c === "{") {
      bracesCount++
    }

    if (c === "}") {
      bracesCount--
    }

    if ((c === "|" || c === "&") && bracesCount === 0) {
      return `type ${name} = ${impl}`
    }
  }

  return `interface ${name} ${impl}`
}

export function formatPathOp(pathOp: PathOperation): string {
  const typesOutput = formatPathOpTypes(pathOp)

  const queryVar = formatQueryVar(pathOp)
  const url = formatURL(pathOp)
  const urlWithQuery = queryVar ? `${url}\${query}` : url

  const dataVar = formatDataVar(pathOp)

  // prettier-ignore
  const functionOutput = `
export async function ${formatName(pathOp)}(
  params: ${paramsName(pathOp)},
  options: RequestOptions = {}
): Promise<${resultName(pathOp)}> {
  ${queryVar}

  const response = await fetch(\`${urlWithQuery}\`, {
    ${formatBodyField(pathOp)}
    method: "${pathOp.operation.toUpperCase()}",
    credentials: "same-origin",
    signal: options.signal,
    ${formatHeadersField(pathOp)}
  })

  const {status, headers} = response

  ${dataVar}

  return {status, headers, ${dataVar ? 'data' : ''}} as ${resultName(pathOp)}
}
`.trim()

  return `${formatPathOpTypes(pathOp)}\n\n${functionOutput}`
}

export function formatLib(): string {
  return `
interface RequestOptions {
  signal?: AbortSignal;
}
`.trim()
}

function uppercase1(s: string) {
  return s.length ? `${s[0].toUpperCase()}${s.slice(1)}` : s
}

function depluralize(s: string) {
  return s.endsWith("s") ? s.slice(0, s.length - 1) : s
}

function formatName({ path, operation }: PathOperation): string {
  const nicePathName = path
    .split("/")
    .map((p, i, ps) => {
      const isGettingSingleResource =
        operation === "get" && i === ps.length - 2 && ps[i + 1].startsWith("{")

      const isAddressingSingleResource =
        operation !== "get" && i === ps.length - 1

      if (isGettingSingleResource || isAddressingSingleResource) {
        return depluralize(p)
      }

      return p
    })
    .filter(p => !p.startsWith("{"))
    .join("-")

  const verb = {
    get: "get",
    post: "create",
    put: "replace",
    patch: "update",
    delete: "delete"
  }[operation]

  return camelize(`${verb}-${nicePathName}`)
}

function paramsName(pathOp: PathOperation): string {
  const pathOpName = formatName(pathOp)

  return `${uppercase1(pathOpName)}Params`
}

function resultName(pathOp: PathOperation): string {
  const pathOpName = formatName(pathOp)

  return `${uppercase1(pathOpName)}Result`
}

function resultVariantName(pathOp: PathOperation, code: string): string {
  const pathOpName = formatName(pathOp)

  return `${uppercase1(pathOpName)}${STATUSES[code]}Result`
}

function formatPathOpTypes(pathOperation: PathOperation): string {
  const paramsType = printParamsType(pathOperation)
  const responseTypes = printResultTypes(pathOperation)

  return `${paramsType}\n\n${responseTypes}`
}

function formatQueryParams({ queryParams }: PathOperation): string {
  if (!queryParams.length) {
    return ""
  }

  const fieldRequired = queryParams.some(d => d.required)

  const typeImpl = `{
  ${queryParams
    .map(d => formatTypeField(false, d.name, d.required, d.type, d.description))
    .join("\n")}
}`

  return formatTypeField(false, "query", fieldRequired, typeImpl)
}

function formatPathParams({ positionalParams }: PathOperation): string {
  if (!positionalParams.length) {
    return ""
  }

  return positionalParams
    .map(d => formatTypeField(false, d.name, d.required, d.type))
    .join("\n")
}

function formatHeadersParams({ headerParams }: PathOperation): string {
  if (!headerParams.length) {
    return ""
  }

  const fieldRequired = headerParams.some(d => d.required)

  const typeImpl = `{
  ${headerParams
    .map(d =>
      formatTypeField(false, `"${d.name}"`, d.required, d.type, d.description)
    )
    .join("\n")}
}`

  return formatTypeField(false, "headers", fieldRequired, typeImpl)
}

function printParamsType(pathOp: PathOperation): string {
  const dataField = pathOp.bodyParam
    ? formatTypeField(
        false,
        "data",
        pathOp.bodyParam.required,
        pathOp.bodyParam.type,
        pathOp.bodyParam.description
      )
    : ""

  const impl = `
{
  ${formatPathParams(pathOp)}

  ${dataField}

  ${formatQueryParams(pathOp)}

  ${formatHeadersParams(pathOp)}
}
`.trim()

  return formatTypeDeclaration(paramsName(pathOp), impl)
}

function printResultTypes(pathOp: PathOperation): string {
  const variants = pathOp.responses.map(({ code, mediaTypes }) =>
    printResultType(code, mediaTypes, resultVariantName(pathOp, code))
  )

  const responseTypes = `
type ${resultName(pathOp)} =
  | ${variants.map(([name]) => name).join("\n  | ")}

${variants.map(([_, type]) => type).join("\n\n")}
`.trim()

  return responseTypes
}

function printResultType(
  code: string,
  mediaTypes: PathOperation["responses"][0]["mediaTypes"],
  name: string
): [string, string] {
  let resolvedTypeImpl = "any"

  const jsonMediaType = mediaTypes.find(d =>
    d.mediaType.includes("application/json")
  )
  const textMediaType = mediaTypes.find(d => d.mediaType.includes("text"))
  const fallbackMediaType = mediaTypes[0]

  if (jsonMediaType) {
    resolvedTypeImpl = jsonMediaType.type
  } else if (textMediaType) {
    resolvedTypeImpl = textMediaType.type
  } else if (fallbackMediaType) {
    resolvedTypeImpl = fallbackMediaType.type
  }

  const resultType = `
interface ${name} {
  status: ${code === "default" ? 500 : code};
  headers: Headers;
  data: ${resolvedTypeImpl};
}
`.trim()

  return [name, resultType]
}

function formatURL({ path, server }: PathOperation) {
  return server + path.replace(/{/g, "${params.")
}

function formatQueryVar({ queryParams }: PathOperation) {
  return queryParams.length
    ? "const query = params.query ? `?${new URLSearchParams(params.query as any)}` : ''"
    : ""
}

function formatBodyField({ bodyParam }: PathOperation) {
  let body

  if (bodyParam && bodyParam.mediaType.includes("application/json")) {
    body = "body: JSON.stringify(params.data),"
  } else if (bodyParam) {
    body = "body: params.data,"
  } else {
    body = ""
  }

  return body
}

function formatContentTypeHeader({ bodyParam }: PathOperation) {
  if (!bodyParam) {
    return ""
  }

  return `'Content-Type': "${bodyParam.mediaType}",`
}

function formatHeadersField(pathOp: PathOperation) {
  const contentTypeHeader = formatContentTypeHeader(pathOp)
  const { headerParams } = pathOp

  if (!contentTypeHeader && !headerParams.length) {
    return ""
  }

  return `headers: { ${contentTypeHeader} ${
    headerParams.length ? "...params.headers," : ""
  } },`
}

function flatMap(xs, f) {
  const xss = xs.map(f)

  return [].concat(...xss)
}

function formatDataVar(pathOp: PathOperation): string {
  const emptyResponse =
    flatMap(pathOp.responses, r => r.mediaTypes).length === 0

  if (emptyResponse) {
    return ``
  }

  const mediaTypes = flatMap(pathOp.responses, r =>
    r.mediaTypes.map(d => d.mediaType)
  )

  const alwaysRespondsJSON = mediaTypes.every(d =>
    d.includes("application/json")
  )

  const neverRespondsJSON = mediaTypes.every(
    d => !d.includes("application/json")
  )

  if (alwaysRespondsJSON) {
    return `const data = await response.json()`
  }

  if (neverRespondsJSON) {
    return `const data = await response.text()`
  }

  return `
  const contentType = response.headers.get('Content-Type')

  let data: any

  if (contentType.includes('application/json')) {
    data = await response.json()
  } else {
    data = await response.text()
  }
`.trim()
}