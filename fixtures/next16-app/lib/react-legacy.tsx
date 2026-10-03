import ReactDOM from 'react-dom';
import { render } from 'react-dom';
import PropTypes from 'prop-types';

function Card({ title = 'x' }: { title?: string }) {
  return <div>{title}</div>;
}
Card.defaultProps = { title: 'y' };
Card.propTypes = { title: PropTypes.string };

ReactDOM.render(<Card />, document.getElementById('root'));
render(<Card />, document.body);
