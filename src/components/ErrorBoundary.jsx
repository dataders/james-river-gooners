import { Component } from 'react'

// Catches render-time errors anywhere below it so a single bad item or component
// can't blank the whole page. Without this, any thrown error in the tree unmounts
// the app and the user sees a white screen.
export class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    console.error('Uncaught error in React tree:', error, info)
  }

  handleReload = () => {
    window.location.reload()
  }

  render() {
    if (this.state.error) {
      return (
        <div className="error">
          <p>Something went wrong rendering the page.</p>
          <p>{this.state.error.message}</p>
          <button type="button" className="deals-toggle" onClick={this.handleReload}>
            Reload
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
