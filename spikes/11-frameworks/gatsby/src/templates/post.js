import * as React from "react"

export default function Post({ pageContext }) {
  return (
    <main style={{ fontFamily: "'Inter Variable', sans-serif" }}>
      <h1>Post {pageContext.id}</h1>
    </main>
  )
}

export const Head = ({ pageContext }) => <title>Post {pageContext.id}</title>
